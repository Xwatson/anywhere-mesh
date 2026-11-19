"""Verify the public domain from a browser's network, using the system trust store."""
import base64
import hashlib
from http.client import HTTPSConnection
from http.cookies import SimpleCookie
import json
import secrets
import sys
from pathlib import Path

from wan_endpoint import endpoint

host, is_domain = endpoint(sys.argv[1])
if not is_domain:
    raise SystemExit('This check requires a DNS hostname')
accounts = json.loads(Path(sys.argv[2]).read_text())
admin = next(user for user in accounts if user['isAdmin'])
report = {'domain': host}
client = HTTPSConnection(host, timeout=25)
origin = 'https://' + host


def call(method, path, body=None, cookie=None):
    headers = {'Origin': origin}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    if cookie:
        headers['Cookie'] = cookie
    client.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
    response = client.getresponse()
    return response, response.read()


try:
    page, html = call('GET', '/')
    assert page.status == 200 and '设备管理' in html.decode(), 'Missing management page'
    report['page'] = page.status
    report['edge'] = page.getheader('server')
    response, _ = call('GET', '/api/admin/devices')
    assert response.status == 401, 'Anonymous device list was not rejected'
    report['anonymousDevices'] = response.status
    response, body = call('POST', '/api/auth/login', {k: admin[k] for k in ('username', 'password')})
    assert response.status == 200 and json.loads(body)['user']['isAdmin'], 'Admin login failed'
    cookies = SimpleCookie()
    cookies.load(response.getheader('Set-Cookie'))
    session, = cookies.values()
    assert session['secure'] and session['httponly'] and session['samesite'].lower()=='strict'
    cookie = session.key + '=' + session.value
    try:
        response, body = call('GET', '/api/admin/devices', cookie=cookie)
        assert response.status == 200 and isinstance(json.loads(body), list)
        report['authenticatedDevices'] = response.status
        report['deviceCount'] = len(json.loads(body))
    finally:
        response, _ = call('POST', '/api/auth/logout', {}, cookie)
        assert response.status == 200
finally:
    client.close()

client = HTTPSConnection(host, timeout=25)
key = base64.b64encode(secrets.token_bytes(16)).decode()
try:
    client.request('GET', '/easytier', headers={
        'Upgrade': 'websocket', 'Connection': 'Upgrade', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
    })
    response = client.getresponse()
    accept = base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
    assert response.status == 101 and response.getheader('Sec-WebSocket-Accept') == accept, 'WebSocket upgrade failed'
    report['easyTierUpgrade'] = response.status
finally:
    client.close()

result = json.dumps(report, ensure_ascii=False, indent=2)
Path(sys.argv[3]).write_text(result + '\n')
print(result)
