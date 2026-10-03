#!/usr/bin/env python3
"""Run ignored Rust integration tests with one disposable database per test.

Uses the local compose PostgreSQL container and creates a dedicated Redis.
PANSOU_TEST_DATABASE_URL supplies connection credentials (never printed).
Optional positional arguments are exact Rust test names; default is all ignored tests.
"""
import argparse
import base64
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]


def run(args, **kwargs):
    return subprocess.run(args, cwd=ROOT, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tests', nargs='*')
    parser.add_argument('--postgres-container', default='pansou-postgres-1')
    parser.add_argument('--postgres-user', default='postgres')
    args = parser.parse_args()
    base = urlsplit(os.environ.get('PANSOU_TEST_DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:5432/pansou_isolated_test'))
    if not base.path.endswith('_test') or base.hostname not in ('localhost', '127.0.0.1', '::1'):
        parser.error('Use a local PANSOU_TEST_DATABASE_URL whose database ends in _test')
    listed = subprocess.run(['cargo', 'test', '--bin', 'pansou-api', '--', '--ignored', '--list'], cwd=ROOT, capture_output=True, text=True)
    if listed.returncode:
        print(listed.stderr, flush=True)
        return True
    listing = listed.stdout
    available = [line[:-6] for line in listing.splitlines() if line.endswith(': test')]
    tests = args.tests or available
    if any(name not in available for name in tests):
        parser.error('Every requested name must exactly match an ignored Rust integration test')
    logs = Path(tempfile.mkdtemp(prefix='pansou-isolated-tests-'))
    container = 'pansou-test-redis-' + uuid.uuid4().hex[:12]
    failures = []
    try:
        run(['docker', 'run', '-d', '--name', container, '-p', '127.0.0.1::6379', 'redis:8-alpine'], stdout=subprocess.DEVNULL)
        for _ in range(40):
            ping = subprocess.run(['docker', 'exec', container, 'redis-cli', 'ping'], capture_output=True, text=True)
            if ping.returncode == 0 and 'PONG' in ping.stdout: break
            time.sleep(.1)
        else: raise RuntimeError('Dedicated test Redis did not start')
        address = run(['docker', 'port', container, '6379/tcp'], capture_output=True, text=True).stdout.strip()
        redis_url = 'redis://' + address + '/15'
        for index, name in enumerate(tests, 1):
            database = 'pansou_isolated_' + uuid.uuid4().hex[:20] + '_test'
            run(['docker', 'exec', args.postgres_container, 'createdb', '-U', args.postgres_user, database])
            log = logs / (name.replace('::', '__') + '.log')
            try:
                run(['docker', 'exec', container, 'redis-cli', '-n', '15', 'FLUSHDB'], stdout=subprocess.DEVNULL)
                env = dict(os.environ, PANSOU_TEST_DATABASE_URL=urlunsplit(base._replace(path='/' + database)), PANSOU_TEST_REDIS_URL=redis_url, PANSOU_CLOUD_CREDENTIAL_KEY=base64.b64encode(os.urandom(32)).decode())
                print(f'[{index}/{len(tests)}] {name}', flush=True)
                with log.open('w') as stream:
                    result = subprocess.run(['cargo', 'test', '--bin', 'pansou-api', name, '--', '--ignored', '--exact', '--nocapture'], cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=300)
                if result.returncode: failures.append(name); print(f'  FAILED: {log}', flush=True)
                else: print('  passed', flush=True)
            finally:
                run(['docker', 'exec', args.postgres_container, 'dropdb', '-U', args.postgres_user, '--force', database])
    finally:
        subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f'{len(tests) - len(failures)}/{len(tests)} passed; logs: {logs}', flush=True)
    return bool(failures)


if __name__ == '__main__':
    raise SystemExit(main())
