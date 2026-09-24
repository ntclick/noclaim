import http.server
import json
import urllib.request
import urllib.error
import urllib.parse
import os
import sys

PORT = 5174
DIRECTORY = os.path.join(os.path.dirname(__file__), 'frontend')
RPC_URL = 'https://studio-next.genlayer.com/api'

def rpc_call(method, params):
    payload = json.dumps({
        'jsonrpc': '2.0',
        'method': method,
        'params': params,
        'id': 1
    }).encode('utf-8')
    req = urllib.request.Request(
        RPC_URL,
        data=payload,
        headers={
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    )
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read().decode('utf-8'))

class DevHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/faucet':
            qs = urllib.parse.parse_qs(parsed.query)
            address = qs.get('address', [None])[0]
            if not address or not address.startswith('0x'):
                self._send_json({'ok': False, 'error': 'Invalid or missing address parameter (must start with 0x)'}, status=400)
                return

            try:
                try:
                    import web3
                    address = web3.Web3.to_checksum_address(address)
                except Exception as e:
                    print(f"Checksum error: {e}", flush=True)
                print(f"--> [Faucet] Funding 20 GEN to: {address}", flush=True)
                # Fund 20 test GEN
                res = rpc_call('sim_fundAccount', [address, 20000000000000000000])
                print(f"<-- [Faucet] Response: {res}", flush=True)
                if 'error' in res:
                    self._send_json({'ok': False, 'error': res['error'].get('message', str(res['error']))}, status=500)
                    return
                tx_hash = res.get('result')

                # Poll balance for up to 8s
                import time
                final_bal = '0'
                for _ in range(5):
                    time.sleep(1.5)
                    b_res = rpc_call('eth_getBalance', [address, 'latest'])
                    if 'result' in b_res and b_res['result']:
                        val = int(b_res['result'], 16)
                        final_bal = f'{val / 10**18:.3f}'
                        if val > 0:
                            break

                self._send_json({
                    'ok': True,
                    'txHash': tx_hash,
                    'balance': final_bal,
                    'message': f'Funded 20 test GEN to {address}'
                })
            except Exception as e:
                self._send_json({'ok': False, 'error': str(e)}, status=500)
            return

        return super().do_GET()

    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

if __name__ == '__main__':
    server = http.server.HTTPServer(('127.0.0.1', PORT), DevHandler)
    print(f'Serving NoClaim on http://localhost:{PORT} (with local faucet proxy /api/faucet)...')
    server.serve_forever()
