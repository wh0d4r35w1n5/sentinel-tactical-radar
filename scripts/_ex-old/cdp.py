"""cdp.py — minimal raw-CDP driver for the clone Chrome on :9222.
Chrome 154 rejects websocket handshakes carrying an Origin header that isn't
whitelisted, so we use websocket-client with suppress_origin=True and drive
everything over Runtime.evaluate / Page.* / Input.* domains.
"""
import json, base64, urllib.request, websocket

DEBUG_PORT = 9222


def browser_ws_url():
    v = json.load(urllib.request.urlopen(
        f'http://localhost:{DEBUG_PORT}/json/version', timeout=5))
    return v['webSocketDebuggerUrl']


class CDP:
    def __init__(self):
        self.ws = websocket.create_connection(
            browser_ws_url(), timeout=30, suppress_origin=True)
        self._id = 0
        self.sid = None  # attached page session

    def cmd(self, method, params=None, session=None, timeout=30):
        self._id += 1
        mid = self._id
        msg = {'id': mid, 'method': method}
        if params:
            msg['params'] = params
        sid = session or self.sid
        if sid:
            msg['sessionId'] = sid
        self.ws.send(json.dumps(msg))
        self.ws.settimeout(timeout)
        while True:
            r = json.loads(self.ws.recv())
            if r.get('id') == mid:
                if 'error' in r:
                    raise RuntimeError(f"{method} -> {r['error']}")
                return r.get('result', {})

    def attach_page(self, url_substr=None):
        """Attach to a page target (optionally by url substring); returns sid."""
        targets = self.cmd('Target.getTargets')['targetInfos']
        pages = [t for t in targets if t['type'] == 'page']
        pick = None
        if url_substr:
            pick = next((t for t in pages if url_substr in t.get('url', '')), None)
        pick = pick or (pages[0] if pages else None)
        if not pick:
            pick = self.cmd('Target.createTarget', {'url': 'about:blank'})
            tid = pick['targetId']
        else:
            tid = pick['targetId']
        self.sid = self.cmd('Target.attachToTarget',
                            {'targetId': tid, 'flatten': True})['sessionId']
        self.cmd('Page.enable')
        self.cmd('Runtime.enable')
        return self.sid, pick.get('url')

    def navigate(self, url, settle=2.0):
        self.cmd('Page.navigate', {'url': url})
        import time
        time.sleep(settle)

    def eval(self, expr, timeout=30):
        r = self.cmd('Runtime.evaluate', {
            'expression': expr, 'returnByValue': True,
            'awaitPromise': True, 'timeout': timeout * 1000})
        if 'exceptionDetails' in r:
            raise RuntimeError(
                str(r['exceptionDetails'].get('exception', {}).get('description',
                    r['exceptionDetails']))[:300])
        return r.get('result', {}).get('value')

    def shot(self, path):
        d = self.cmd('Page.captureScreenshot', {'format': 'png'})
        with open(path, 'wb') as f:
            f.write(base64.b64decode(d['data']))

    def list_pages(self):
        return [(t['targetId'], t.get('url')) for t in
                self.cmd('Target.getTargets')['targetInfos']
                if t['type'] == 'page']
