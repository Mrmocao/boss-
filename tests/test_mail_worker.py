import importlib.util
import io
import tempfile
import unittest
import zipfile
from email.message import EmailMessage
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('mail_worker', ROOT / 'scripts/mail_worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class MailTests(unittest.TestCase):
    def account(self):
        return dict(id='hr-1', address='hr-rpg@youkia.net', enabled=True, host='mail.example.test', username='hr', password='secret', port=993)

    def email(self):
        message = EmailMessage()
        message['Subject'] = '材料 BOSS-1234567890ABCDEF'
        message['From'] = 'candidate@example.test'
        message['To'] = 'hr-rpg@youkia.net'
        message['Date'] = 'Tue, 10 Nov 2026 12:00:00 +0800'
        message.set_content('已完成问卷')
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as book:
            book.writestr('xl/workbook.xml', '<workbook/>')
        message.add_attachment(archive.getvalue(), maintype='application', subtype='octet-stream', filename='../../问卷.xlsx')
        message.add_attachment(b'%PDF-1.7\nresume', maintype='application', subtype='pdf', filename='简历.pdf')
        return message.as_bytes()

    def test_parse_and_save_safe_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            result = worker.parse_receipt(self.email(), self.account(), 'safe-id', root)
            self.assertEqual({f['role'] for f in result['attachments']}, {'questionnaire', 'resume'})
            for attachment in result['attachments']:
                self.assertTrue(Path(attachment['path']).is_relative_to(root))
                self.assertTrue(Path(attachment['path']).is_file())

    def test_wrong_recipient_does_not_match(self):
        with tempfile.TemporaryDirectory() as temp:
            account = self.account()
            account['address'] = 'other@example.test'
            self.assertIsNone(worker.parse_receipt(self.email(), account, 'id', Path(temp)))

    def test_normal_subject_accepts_chinese_or_iso_date_without_identifier(self):
        for subject in ['张三-数值策划-2026-11-11', '张三 - 数值策划 - 2026年11月11日', '张三-数值策划-2026/11/11 10:30']:
            self.assertEqual(worker.parse_submission_subject(subject), {'name': '张三', 'jobTitle': '数值策划', 'date': '2026-11-11'})
        self.assertIsNone(worker.parse_submission_subject('张三-数值策划-2026-02-31'))
        with tempfile.TemporaryDirectory() as temp:
            from email.parser import BytesParser
            from email import policy
            message = BytesParser(policy=policy.default).parsebytes(self.email())
            message.replace_header('Subject', '张三-数值策划-2026-11-11')
            result = worker.parse_receipt(message.as_bytes(), self.account(), 'normal', Path(temp))
            self.assertIsNone(result['token'])
            self.assertEqual(result['submissionSubject']['name'], '张三')
            self.assertEqual(len(result['attachments']), 2)

    def test_disabled_blank_credentials_are_allowed_but_enabled_is_rejected(self):
        self.assertFalse(worker.validate_account({'id':'hr', 'enabled':False}))
        with self.assertRaises(ValueError):
            worker.validate_account({'id':'hr', 'enabled':True})

    def test_sync_is_readonly_uid_deduplicated_and_account_scoped(self):
        raw = self.email()
        calls = []
        class Fake:
            def login(self, *args): pass
            def select(self, folder, readonly=False):
                self.assert_readonly = readonly
                calls.append(('readonly', readonly))
                return 'OK', [b'1']
            def response(self, name): return name, [b'42']
            def uid(self, command, *args):
                calls.append((command, args))
                if command == 'search': return 'OK', [b'1']
                if args[-1] == '(RFC822.SIZE)': return 'OK', [b'1 (RFC822.SIZE ' + str(len(raw)).encode() + b')']
                return 'OK', [(b'1', raw)]
            def logout(self): pass
        with tempfile.TemporaryDirectory() as temp:
            first = worker.sync_account(self.account(), Path(temp), Fake)
            second = worker.sync_account(self.account(), Path(temp), Fake)
            self.assertEqual(first['imported'], 1)
            self.assertEqual(second['imported'], 0)
            self.assertIn(('readonly', True), calls)
            self.assertTrue(any('(BODY.PEEK[])' in args for method, args in calls if method == 'fetch'))
            other = self.account(); other['id'] = 'hr-2'; other['username'] = 'other'
            self.assertNotEqual(worker.sync_account(other, Path(temp), Fake)['receiptsFile'], first['receiptsFile'])


if __name__ == '__main__':
    unittest.main()
