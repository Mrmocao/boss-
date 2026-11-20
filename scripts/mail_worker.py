"""Read configured IMAP mailboxes without marking messages read; save local receipts."""
import argparse
import hashlib
import imaplib
import io
import json
import re
import sqlite3
import ssl
import zipfile
from datetime import datetime, timezone, timedelta
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses, parsedate_to_datetime
from pathlib import Path


def digest(value):
    return hashlib.sha256(value).hexdigest()


def atomic(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def parse_submission_subject(subject):
    match = re.fullmatch(r'\s*(.+?)\s*[-－—]\s*(.+?)\s*[-－—]\s*(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?\s*', subject)
    if not match:
        return None
    name, job, year, month, day, hour, minute = match.groups()
    try:
        date = datetime(int(year), int(month), int(day), int(hour or 0), int(minute or 0))
    except ValueError:
        return None
    return {'name': name.strip(), 'jobTitle': job.strip(), 'date': date.strftime('%Y-%m-%d')}


def parse_receipt(raw, account, key, root):
    message = BytesParser(policy=policy.default).parsebytes(raw)
    subject = str(message.get('Subject', ''))
    tokens = list(set(re.findall(r'\bBOSS-[A-F0-9]{16}\b', subject)))
    submission_subject = parse_submission_subject(subject)
    senders = getaddresses(message.get_all('From', []))
    recipients = [address.lower() for _, address in getaddresses(message.get_all('To', []) + message.get_all('Cc', []))]
    if account['address'].lower() not in recipients:
        return None
    if (len(tokens) != 1 and not submission_subject) or len(senders) != 1 or not senders[0][1]:
        if any(part.get_filename() and re.search('简历|问卷|试题|resume|questionnaire', part.get_filename(), re.I) for part in message.walk()):
            return {'id': key, 'mailboxId': account['id'], 'reviewReason': '收到招聘材料但姓名、岗位、提交日期或发件人不明确，请在邮箱人工核对', 'subject': subject[:500]}
        return None
    if re.match(r'\s*(fw:|fwd:|转发)', subject, re.I):
        return None
    date = None
    try:
        date = parsedate_to_datetime(str(message.get('Date'))).astimezone(timezone.utc).isoformat()
    except (ValueError, TypeError, AttributeError):
        pass
    result = {'id': key, 'mailboxId': account['id'], 'recipient': account['address'].lower(),
              'token': tokens[0] if len(tokens) == 1 else None, 'submissionSubject': submission_subject,
              'sender': senders[0][1].lower(), 'subject': subject[:500], 'date': date,
              'observedAt': datetime.now(timezone.utc).isoformat(), 'attachments': []}
    for part in message.walk():
        name = part.get_filename()
        if not name or part.is_multipart():
            continue
        data = part.get_payload(decode=True) or b''
        if not data or len(data) > 10_000_000:
            continue
        lower = name.lower()
        role = None
        extension = None
        if lower.endswith('.xlsx'):
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as book:
                    if 'xl/workbook.xml' in book.namelist() and not any('vbaproject' in p.lower() for p in book.namelist()):
                        role = 'questionnaire' if re.search('问卷|试题|笔试|questionnaire|assessment', lower) else None
                        extension = '.xlsx'
            except zipfile.BadZipFile:
                continue
        elif lower.endswith('.pdf') and data.startswith(b'%PDF-'):
            role = 'resume' if re.search('简历|resume|\bcv\b', lower) else None
            extension = '.pdf'
        elif lower.endswith('.docx'):
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as doc:
                    if 'word/document.xml' in doc.namelist():
                        role = 'resume' if re.search('简历|resume|\bcv\b', lower) else None
                        extension = '.docx'
            except zipfile.BadZipFile:
                continue
        if not extension:
            continue
        checksum = digest(data)
        folder = root / 'attachments' / key
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / (checksum + extension)
        target.write_bytes(data)  # The untrusted original filename is never used as a path.
        result['attachments'].append({'name': name[:255], 'role': role, 'sha256': checksum,
                                      'path': str(target), 'bytes': len(data)})
    return result


def validate_account(account):
    if not isinstance(account, dict) or not re.fullmatch(r'[a-z0-9-]{1,50}', account.get('id', '')):
        raise ValueError('MAIL_CONFIG_INVALID')
    if not account.get('enabled'):
        return False
    for key in ('address', 'host', 'username', 'password'):
        if not isinstance(account.get(key), str) or not account[key].strip() or any(c in account[key] for c in '\r\n'):
            raise ValueError('MAIL_CONFIG_INCOMPLETE')
    if not isinstance(account.get('port', 993), int) or not 1 <= account.get('port', 993) <= 65535:
        raise ValueError('MAIL_CONFIG_INVALID')
    if not isinstance(account.get('folder', 'INBOX'), str) or any(c in account.get('folder', '') for c in '\r\n"'):
        raise ValueError('MAIL_CONFIG_INVALID')
    return True


def sync_account(account, root, connect=None):
    if not validate_account(account):
        return {'id': account['id'], 'status': 'disabled'}
    identity = digest(json.dumps([account['address'].lower(), account['host'], account['username'], account.get('port', 993)], ensure_ascii=False).encode())[:20]
    folder_root = root / account['id'] / identity
    folder_root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(folder_root / 'index.sqlite', timeout=2)
    db.execute('CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, uid INTEGER, receipt TEXT)')
    client = None
    try:
        client = (connect or (lambda: imaplib.IMAP4_SSL(account['host'], account.get('port', 993), ssl_context=ssl.create_default_context(), timeout=15)))()
        client.login(account['username'], account['password'])
        folder = account.get('folder', 'INBOX')
        status, _ = client.select('"' + folder + '"', readonly=True)
        if status != 'OK':
            raise RuntimeError('MAIL_SELECT_FAILED')
        validity = client.response('UIDVALIDITY')[1][0]
        if not validity or not validity.isdigit():
            raise RuntimeError('MAIL_UIDVALIDITY_MISSING')
        since = (datetime.now(timezone.utc) - timedelta(days=30)).strftime('%d-%b-%Y')
        status, data = client.uid('search', None, '(SINCE ' + since + ')')
        if status != 'OK':
            raise RuntimeError('MAIL_SEARCH_FAILED')
        added = 0
        remaining = 0
        for uid in (data[0] or b'').split():
            if not uid.isdigit():
                continue
            key = digest((identity + '|' + folder + '|').encode() + validity + b'|' + uid)
            if db.execute('SELECT 1 FROM seen WHERE key=?', (key,)).fetchone():
                continue
            if added >= 100:
                remaining += 1
                continue
            status, meta = client.uid('fetch', uid, '(RFC822.SIZE)')
            size_match = re.search(rb'RFC822.SIZE (\d+)', b' '.join(x for x in meta if isinstance(x, bytes)))
            if status != 'OK' or not size_match:
                raise RuntimeError('MAIL_SIZE_FAILED')
            size = int(size_match[1])
            if size > 15_000_000:
                receipt = {'id': key, 'mailboxId': account['id'], 'reviewReason': '邮件超过15MB，需在邮箱人工查看'}
            else:
                status, content = client.uid('fetch', uid, '(BODY.PEEK[])')
                if status != 'OK':
                    raise RuntimeError('MAIL_FETCH_FAILED')
                raw = b''.join(item[1] for item in content if isinstance(item, tuple) and isinstance(item[1], bytes))
                if not raw or len(raw) > 15_000_000:
                    raise RuntimeError('MAIL_BODY_INVALID')
                receipt = parse_receipt(raw, account, key, folder_root)
            db.execute('INSERT INTO seen VALUES (?,?,?)', (key, int(uid), json.dumps(receipt, ensure_ascii=False) if receipt else None))
            db.commit()
            added += 1
        receipts = [json.loads(row[0]) for row in db.execute('SELECT receipt FROM seen WHERE receipt IS NOT NULL ORDER BY uid DESC LIMIT 1000')]
        atomic(folder_root / 'receipts.json', receipts)
        return {'id': account['id'], 'identity': identity, 'status': 'connected', 'imported': added, 'remaining': remaining,
                'coverage': 'last_30_days', 'receiptsFile': str(folder_root / 'receipts.json')}
    finally:
        db.close()
        if client:
            try:
                client.logout()
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--root', required=True, type=Path)
    args = parser.parse_args()
    args.root.mkdir(parents=True, exist_ok=True)
    result = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'accounts': []}
    try:
        config = json.loads(args.config.read_text(encoding='utf-8-sig'))
        accounts = config.get('mailboxes', [])
        if not isinstance(accounts, list) or len(accounts) > 20:
            raise ValueError()
        ids = [a.get('id') for a in accounts]
        if len(set(ids)) != len(ids):
            raise ValueError()
        for account in accounts:
            try:
                result['accounts'].append(sync_account(account, args.root))
            except Exception:
                result['accounts'].append({'id': str(account.get('id', 'invalid'))[:50], 'status': 'error', 'error': '邮箱配置、登录或收件失败，请核对IMAP设置'})
    except Exception:
        result['error'] = 'MAIL_CONFIG_INVALID'
    atomic(args.root / 'status.json', result)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
