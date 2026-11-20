"""Explicit QQ SMTP sender; separate from IMAP inbox receipt verification."""
import argparse
import hashlib
import json
import mimetypes
from pathlib import Path
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formatdate, make_msgid


def settings(path):
    data = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    if data.get('security') != 'ssl' or not isinstance(data.get('port'), int) or not 1 <= data['port'] <= 65535:
        raise ValueError('SMTP_CONFIG_INVALID')
    for key in ('host', 'username', 'password', 'fromAddress'):
        if not isinstance(data.get(key), str) or not data[key].strip() or any(c in data[key] for c in '\r\n'):
            raise ValueError('SMTP_CONFIG_INCOMPLETE')
    if data.get('toAddress') != 'hr-rpg@youkia.net' or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', data['fromAddress']):
        raise ValueError('SMTP_ADDRESS_INVALID')
    if data['username'].lower() != data['fromAddress'].lower():
        raise ValueError('SMTP_FROM_MISMATCH')
    return data


def send_report(config, request, ledger, connect=None):
    if config.get('enabled') is not True:
        raise ValueError('SMTP_DISABLED')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', request.get('id', '')):
        raise ValueError('MAIL_REQUEST_ID_REQUIRED')
    if not isinstance(request.get('subject'), str) or not request['subject'].strip() or any(c in request['subject'] for c in '\r\n'):
        raise ValueError('MAIL_SUBJECT_INVALID')
    if not isinstance(request.get('body'), str) or len(request['body']) > 20000:
        raise ValueError('MAIL_BODY_INVALID')
    message = EmailMessage()
    message['From'], message['To'] = config['fromAddress'], config['toAddress']
    message['Subject'], message['Date'], message['Message-ID'] = request['subject'], formatdate(localtime=False), make_msgid()
    message.set_content(request['body'])
    total = 0
    for filename in request.get('attachments', []):
        path = Path(filename)
        if not path.is_absolute() or not path.is_file() or path.stat().st_size > 10_000_000:
            raise ValueError('MAIL_ATTACHMENT_INVALID')
        content = path.read_bytes()
        total += len(content)
        if total > 15_000_000:
            raise ValueError('MAIL_ATTACHMENTS_TOO_LARGE')
        kind = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        main, sub = kind.split('/', 1)
        message.add_attachment(content, maintype=main, subtype=sub, filename=path.name)
    root = Path(ledger)
    root.mkdir(parents=True, exist_ok=True)
    record_path = root / (hashlib.sha256(request['id'].encode()).hexdigest() + '.json')
    record = {'id': request['id'], 'status': 'prepared', 'to': config['toAddress'], 'messageId': message['Message-ID']}
    with record_path.open('x', encoding='utf-8') as handle:
        json.dump(record, handle)
    client = None
    started = False
    try:
        client = (connect or (lambda: smtplib.SMTP_SSL(config['host'], config['port'], context=ssl.create_default_context(), timeout=20)))()
        client.login(config['username'], config['password'])
        record['status'] = 'send_attempt_started'
        record_path.write_text(json.dumps(record), encoding='utf-8')
        started = True
        refused = client.send_message(message, from_addr=config['fromAddress'], to_addrs=[config['toAddress']])
        if refused:
            raise RuntimeError('RECIPIENT_REFUSED')
        # SMTP acceptance is not proof that the receiving inbox delivered/read it.
        record['status'] = 'smtp_accepted'
        record_path.write_text(json.dumps(record), encoding='utf-8')
        return record
    except Exception:
        record['status'] = 'send_unknown' if started else 'not_sent'
        record_path.write_text(json.dumps(record), encoding='utf-8')
        raise RuntimeError('SMTP_SEND_UNCONFIRMED') from None
    finally:
        if client:
            try:
                client.quit()
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['check', 'send'])
    parser.add_argument('--config', required=True)
    parser.add_argument('--request')
    parser.add_argument('--ledger', default=str(Path(__file__).resolve().parents[1] / '.local/outgoing-mail'))
    args = parser.parse_args()
    try:
        config = settings(args.config)
        if args.command == 'check':
            print(json.dumps({'ready': True, 'enabled': config.get('enabled') is True, 'toAddress': config['toAddress'], 'networkRequestMade': False}))
        else:
            if not args.request:
                raise ValueError('MAIL_REQUEST_REQUIRED')
            print(json.dumps(send_report(config, json.loads(Path(args.request).read_text(encoding='utf-8-sig')), args.ledger)))
    except Exception as error:
        code = str(error) if isinstance(error, (ValueError, RuntimeError)) and re.fullmatch('[A-Z_]+', str(error)) else 'MAIL_OPERATION_FAILED'
        print(json.dumps({'ready': False, 'error': code, 'message': '请检查SMTP配置或本地发送记录；不得自动重试未知发送。'}, ensure_ascii=False))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
