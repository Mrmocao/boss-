"""One read-only AI snapshot request. Never print the API credential."""
import argparse
import json
from pathlib import Path
import urllib.request
import urllib.error
from urllib.parse import urlparse


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, default=Path(__file__).resolve().parents[1] / '.local/automation-api.json')
    parser.add_argument('--base-url', help='HTTPS reverse proxy address; default is local API')
    parser.add_argument('--etag-file', type=Path)
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding='utf-8-sig'))
        base = args.base_url or f"http://127.0.0.1:{config['port']}"
        url = urlparse(base)
        if url.username or url.password or url.query or url.fragment or not (url.scheme == 'https' or (url.scheme == 'http' and url.hostname in ('127.0.0.1', 'localhost'))):
            raise ValueError('Use HTTPS for a remote server')
        headers = {'Authorization': 'Bearer ' + config['token'], 'Accept': 'application/json'}
        if args.etag_file and args.etag_file.exists():
            headers['If-None-Match'] = args.etag_file.read_text().strip()
        # Do not follow a redirect carrying an Authorization header.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        opener = urllib.request.build_opener(NoRedirect)
        request = urllib.request.Request(base.rstrip('/') + '/api/v1/snapshot', headers=headers)
        with opener.open(request, timeout=10) as response:
            raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ValueError('Response too large')
            result = json.loads(raw)
            if args.etag_file and response.headers.get('ETag'):
                args.etag_file.write_text(response.headers['ETag'], encoding='utf-8')
            print(json.dumps(result, ensure_ascii=False, indent=2))
    except urllib.error.HTTPError as error:
        if error.code == 304:
            print('{"unchanged":true}')
            return 0
        print(json.dumps({'error': 'HTTP_ERROR', 'status': error.code}))
        return 1
    except Exception:
        print('{"error":"POLL_FAILED","message":"Check API URL, TLS, credential and service state."}')
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
