import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('outgoing_mail', Path(__file__).resolve().parents[1] / 'scripts/outgoing_mail.py')
mail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mail)


class SenderTests(unittest.TestCase):
    def config(self):
        return dict(enabled=True, host='smtp.qq.com', port=465, security='ssl', username='123@qq.com', password='app-code', fromAddress='123@qq.com', toAddress='hr-rpg@youkia.net')

    def test_sender_and_recipient_are_separate(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'config.json'
            path.write_text(json.dumps(self.config()), encoding='utf-8')
            c = mail.settings(path)
            self.assertEqual(c['fromAddress'], '123@qq.com')
            self.assertEqual(c['toAddress'], 'hr-rpg@youkia.net')
            c['toAddress'] = 'other@example.test'
            path.write_text(json.dumps(c), encoding='utf-8')
            with self.assertRaises(ValueError): mail.settings(path)

    def test_explicit_send_acceptance_not_inbox_confirmation_and_no_duplicate(self):
        calls = []
        class Fake:
            def login(self, *args): pass
            def send_message(self, message, **kwargs): calls.append(kwargs); return {}
            def quit(self): pass
        with tempfile.TemporaryDirectory() as folder:
            request = {'id':'unique', 'subject':'材料', 'body':'附件供查看'}
            result = mail.send_report(self.config(), request, folder, Fake)
            self.assertEqual(result['status'], 'smtp_accepted')
            self.assertEqual(calls[0]['to_addrs'], ['hr-rpg@youkia.net'])
            with self.assertRaises(FileExistsError): mail.send_report(self.config(), request, folder, Fake)
            self.assertEqual(len(calls), 1)

    def test_transport_uncertainty_is_not_retried(self):
        class Fake:
            def login(self, *args): pass
            def send_message(self, *args, **kwargs): raise TimeoutError('private detail')
            def quit(self): pass
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(RuntimeError, 'SMTP_SEND_UNCONFIRMED'):
                mail.send_report(self.config(), {'id':'failed','subject':'材料','body':''}, folder, Fake)
            record = json.loads(next(Path(folder).glob('*.json')).read_text())
            self.assertEqual(record['status'], 'send_unknown')


if __name__ == '__main__': unittest.main()
