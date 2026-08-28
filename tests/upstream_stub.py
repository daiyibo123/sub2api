"""Fake upstream provider used by tests/gateway.test.py.

Each instance listens on its own port so a test can tell which account the
gateway actually selected. `POST /__control` sets the next response status or
toggles streaming; `GET /__control` returns the requests that arrived, so a test
can assert on the forwarded model name, auth header and path.

The gateway forwards bodies as a ReadableStream, which reaches us as
`Transfer-Encoding: chunked` with no Content-Length. The body reader below
handles both framings; reading the chunked body fully also drains the socket,
which otherwise shows up in the worker as "Network connection lost".
"""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
STATE = {}


def _blank():
    return {'status': 200, 'requests': [], 'stream': False}


class Handler(BaseHTTPRequestHandler):
    # Chunked request bodies require HTTP/1.1.
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def _port(self):
        return self.server.server_address[1]

    def _read_body(self):
        encoding = (self.headers.get('transfer-encoding') or '').lower()
        if 'chunked' in encoding:
            chunks = []
            while True:
                line = self.rfile.readline().strip()
                if not line:
                    break
                try:
                    size = int(line.split(b';')[0], 16)
                except ValueError:
                    break
                if size == 0:
                    self.rfile.readline()  # trailing CRLF
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.readline()  # CRLF after each chunk
            return b''.join(chunks)

        length = int(self.headers.get('content-length') or 0)
        return self.rfile.read(length) if length else b''

    def _send(self, status, payload):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        port = self._port()
        with LOCK:
            state = STATE.setdefault(port, _blank())
            if self.path.startswith('/__control'):
                return self._send(200, {'requests': list(state['requests'])})
            status = state['status']
        # Provider "list models" probe used by the account connection test.
        return self._send(status if status >= 400 else 200,
                          {'object': 'list', 'data': [{'id': 'stub-model'}]})

    def do_POST(self):
        port = self._port()
        raw = self._read_body()

        if self.path.startswith('/__control'):
            config = json.loads(raw or b'{}')
            with LOCK:
                state = STATE.setdefault(port, _blank())
                if config.get('reset'):
                    state['requests'] = []
                if 'status' in config:
                    state['status'] = int(config['status'])
                if 'stream' in config:
                    state['stream'] = bool(config['stream'])
            return self._send(200, {'ok': True})

        try:
            body = json.loads(raw or b'{}')
        except Exception:
            body = {}

        with LOCK:
            state = STATE.setdefault(port, _blank())
            state['requests'].append({
                'path': self.path,
                'model': body.get('model'),
                'stream': bool(body.get('stream')),
                'authorization': self.headers.get('authorization'),
                'x_api_key': self.headers.get('x-api-key'),
                'user_agent': self.headers.get('user-agent'),
                'anthropic_version': self.headers.get('anthropic-version'),
            })
            status = state['status']
            want_stream = state['stream']

        if status >= 400:
            return self._send(status, {'error': {'message': f'stub failure {status}', 'type': 'stub'}})

        if want_stream or body.get('stream'):
            # Real providers report usage in a late frame: OpenAI sends a final
            # chunk carrying `usage`, Anthropic a `message_delta`. The gateway
            # parses that frame to record streamed usage, so the stub must send
            # one or the test would assert against data no provider omitted.
            frames = [
                'data: ' + json.dumps({'id': f'chatcmpl-{port}', 'object': 'chat.completion.chunk',
                                       'choices': [{'index': 0, 'delta': {'content': 'hi'}}]}),
                'data: ' + json.dumps({'id': f'chatcmpl-{port}', 'object': 'chat.completion.chunk',
                                       'choices': [],
                                       'usage': {'prompt_tokens': 11, 'completion_tokens': 5,
                                                 'total_tokens': 16}}),
                'data: [DONE]',
            ]
            payload = ('\n\n'.join(frames) + '\n\n').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        # Anthropic-shaped response when the caller used the messages endpoint.
        if 'messages' in self.path:
            return self._send(200, {
                'id': f'msg-{port}', 'type': 'message', 'role': 'assistant',
                'model': body.get('model'),
                'content': [{'type': 'text', 'text': f'from-{port}'}],
                'usage': {'input_tokens': 9, 'output_tokens': 4},
            })

        return self._send(200, {
            'id': f'chatcmpl-{port}', 'object': 'chat.completion',
            'model': body.get('model'),
            'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': f'from-{port}'}, 'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': 11, 'completion_tokens': 5, 'total_tokens': 16},
        })


def serve(port):
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


if __name__ == '__main__':
    ports = [int(value) for value in sys.argv[1:]] or [9101]
    for port in ports:
        serve(port)
    print(f'stub upstreams on {ports}', flush=True)
    threading.Event().wait()
