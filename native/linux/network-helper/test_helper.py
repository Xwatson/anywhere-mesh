import asyncio
import json
import os
import signal
import sys
import tempfile
import unittest
from pathlib import Path
from helper import Fault, Supervisor, parse_request, trusted_file


class Requests(unittest.TestCase):
    def test_rejects_files_below_user_writable_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'profile.json'
            path.write_text('{}')
            with self.assertRaises(Fault): trusted_file(str(path))

    def test_rejects_wrong_binary_digest(self):
        with self.assertRaisesRegex(Fault, 'HASH_MISMATCH'):
            trusted_file(os.path.realpath(sys.executable), '0'*64)

    def test_rejects_executable_paths_and_extra_arguments(self):
        for field in ['command','config','args','env','uid','path']:
            with self.assertRaises(Fault):
                parse_request(json.dumps({'version':1,'id':'1','method':'start',field:'untrusted'}))

    def test_rejects_malformed_and_unknown_requests(self):
        for value in ['[]','null','{','{"version":true,"id":"1","method":"status"}',
                      '{"version":1,"id":"1","method":"exec"}',
                      '{"version":1,"id":"1","method":"stop"}',
                      '{"version":1,"id":"1","method":"renew","lease":"密钥"}']:
            with self.subTest(value=value), self.assertRaises(Fault):
                parse_request(value)


class Lifecycle(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.profile = {'interface':'awtest','virtual_ip':'10.126.10.1','lease_seconds':0.25,
                        'probe_seconds':0.02,'restart_limit':1,'restart_window_seconds':10}
        self.processes = []
        self.reachable = True
        async def spawn():
            p = await asyncio.create_subprocess_exec(sys.executable,'-c','import time; time.sleep(60)',start_new_session=True)
            self.processes.append(p)
            return p
        async def probe(): return self.reachable
        self.s = Supervisor(self.profile,spawn,probe,lambda:False)
        self.watchdog = asyncio.create_task(self.s.watchdog())

    async def asyncTearDown(self):
        self.watchdog.cancel()
        await self.s.stop(force=True)
        for p in self.processes:
            self.assertIsNotNone(p.returncode, 'leaked child process')

    async def until(self, predicate, timeout=4):
        async with asyncio.timeout(timeout):
            while not predicate(): await asyncio.sleep(0.01)

    async def test_single_owner_idempotency_and_wrong_lease(self):
        owner=object(); lease=await self.s.start(owner)
        self.assertEqual(await self.s.start(owner),lease)
        with self.assertRaisesRegex(Fault,'BUSY'): await self.s.start(object())
        with self.assertRaisesRegex(Fault,'NOT_OWNER'): await self.s.stop(object(),lease)
        with self.assertRaisesRegex(Fault,'NOT_OWNER'): await self.s.renew(owner,'wrong')
        await self.until(lambda:self.s.phase=='connected')
        self.assertEqual(len(self.processes),1)
        await self.s.stop(owner,lease)
        self.assertEqual(self.s.phase,'idle')

    async def test_expiry_reaps_child_without_request(self):
        await self.s.start(object())
        await self.until(lambda:self.s.phase=='idle')
        self.assertEqual(self.s.stop_reason,'lease_expired')

    async def test_expired_lease_cannot_be_revived(self):
        owner=object(); lease=await self.s.start(owner)
        self.s.deadline=0
        with self.assertRaisesRegex(Fault,'LEASE_EXPIRED'): await self.s.renew(owner,lease)

    async def test_relay_outage_does_not_spawn_extra_process(self):
        owner=object(); lease=await self.s.start(owner)
        await self.until(lambda:self.s.phase=='connected')
        self.reachable=False
        await self.until(lambda:self.s.phase=='degraded')
        await self.s.renew(owner,lease)
        self.reachable=True
        await self.until(lambda:self.s.phase=='connected')
        self.assertEqual(len(self.processes),1)

    async def test_crash_restart_then_explicit_stop_cancels_backoff(self):
        self.profile['lease_seconds']=10
        owner=object(); lease=await self.s.start(owner)
        await self.until(lambda:self.s.phase=='connected')
        self.processes[0].kill()
        await self.until(lambda:len(self.processes)==2 and self.s.phase=='connected')
        self.processes[1].kill()
        await self.until(lambda:self.s.phase=='restarting')
        await self.s.stop(owner,lease)
        await asyncio.sleep(0.6)
        self.assertEqual(len(self.processes),2)
        self.assertEqual(self.s.phase,'idle')

    async def test_restart_budget_is_bounded(self):
        self.profile['lease_seconds']=10
        await self.s.start(object())
        for count in [1,2]:
            await self.until(lambda:len(self.processes)==count and self.s.phase=='connected')
            self.processes[-1].kill()
        await self.until(lambda:self.s.phase=='failed')
        self.assertEqual(self.s.error,'RESTART_LIMIT')
        self.assertEqual(len(self.processes),2)

    async def test_disconnect_during_spawn_reaps_late_child(self):
        original=self.s.spawn; barrier=asyncio.Event()
        async def delayed():
            p=await original()
            await barrier.wait()
            return p
        self.s.spawn=delayed
        owner=object(); await self.s.start(owner)
        await self.until(lambda:bool(self.processes))
        stopping=asyncio.create_task(self.s.stop(owner,reason='client_disconnected'))
        await asyncio.sleep(0.03); barrier.set()
        await stopping
        self.assertEqual(self.s.phase,'idle')
        self.assertIsNotNone(self.processes[0].returncode)

    async def test_does_not_delete_foreign_interface(self):
        self.s.interface_present=lambda:True
        with self.assertRaisesRegex(Fault,'INTERFACE_IN_USE'): await self.s.start(object())
        self.assertEqual(self.processes,[])


if __name__=='__main__': unittest.main()
