"""Hosted-only compiled-module cases; output fixed receipts, never raw logs."""
import json
import pathlib
import re
import subprocess
import tempfile
import time
import uuid


def docker(*args, timeout=45):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('docker_operation_failed')
    return result.stdout


def inspect(name):
    return json.loads(docker('inspect', name))[0]


def require(condition, marker):
    if not condition:
        raise AssertionError(marker)


def run_packaged(image, fixtures, output):
    with tempfile.TemporaryDirectory(prefix='rc3-push-compiled-') as directory:
        root = pathlib.Path(directory)
        for mode, count, filename in [('push', 20, 'PACKAGED_PUSH_STATUS.json'),
                                      ('retry', 34, 'PACKAGED_LOGIN_RETRY.json')]:
            name = 'rc3-push-compiled-' + uuid.uuid4().hex
            data = root / mode
            data.mkdir()
            created = False
            receipt = {'schema': 1, 'passed': False, 'mode': mode,
                       'expectedCases': count, 'numPassed': 0,
                       'networkMode': 'none', 'rawLogsOmitted': True,
                       'realCloudAuthentication': False, 'productionAccess': False,
                       'productTranspilation': False, 'forcedTermination': False}
            try:
                docker('create', '--name', name, '--platform', 'linux/amd64',
                       '--network', 'none', '--entrypoint', 'node',
                       '--mount', f'type=bind,src={fixtures},dst=/qualification,readonly',
                       '--mount', f'type=bind,src={data},dst=/data',
                       '--env', 'NODE_OPTIONS=--experimental-vm-modules --require=/qualification/network-deny.cjs',
                       '--env', f'QUALIFICATION_TEST={mode}', image,
                       '/usr/src/app/client/node_modules/jest/bin/jest.js',
                       '--config', '/qualification/packaged.jest.config.cjs',
                       '--runInBand', '--json', '--outputFile=/data/jest-result.json')
                created = True
                definition = inspect(name)
                image_id = definition['Image']
                require(re.fullmatch(r'sha256:[0-9a-f]{64}', image_id) is not None, 'invalid_image_identity')
                receipt.update({'imageId': image_id, 'testedImageId': image_id})
                require(definition['HostConfig']['NetworkMode'] == 'none', 'network_not_none')
                require(not definition['HostConfig']['Privileged'], 'privileged_container')
                require(definition['Path'] == 'node', 'test_process_mismatch')
                docker('start', name)
                deadline = time.monotonic() + 90
                while inspect(name)['State']['Running'] and time.monotonic() < deadline:
                    time.sleep(0.2)
                state = inspect(name)['State']
                require(not state['Running'], 'packaged_test_timeout')
                receipt.update({'exitCode': state['ExitCode'], 'oomKilled': state['OOMKilled']})
                results = json.loads((data / 'jest-result.json').read_text())
                guard = json.loads((data / 'network-guard.json').read_text())
                for source, target in [('numPassedTests', 'numPassed'),
                                       ('numFailedTests', 'numFailed'),
                                       ('numPendingTests', 'numPending')]:
                    if type(results.get(source)) is int:
                        receipt[target] = results[source]
                assertions = [case for suite in results.get('testResults', [])
                              for case in suite.get('assertionResults', [])]
                receipt['failedCaseOrdinals'] = [index + 1 for index, case in enumerate(assertions)
                                                 if case.get('status') == 'failed']
                if guard.get('attemptedApis') == []:
                    receipt['blockedOperations'] = 0
                require(state['ExitCode'] == 0 and not state['OOMKilled'], 'packaged_test_failed')
                require(results['success'] is True and results['numTotalTests'] == count
                        and results['numPassedTests'] == count
                        and results['numFailedTests'] == 0
                        and results['numPendingTests'] == 0, 'packaged_case_count_mismatch')
                require(guard['processGuardEnabled'] is True and guard['attemptedApis'] == []
                        and guard['nativeRTCStubbed'] is True
                        and guard['productTranspilation'] is False, 'unexpected_transport_attempt')
                hashes = guard['moduleHashes']
                require(len(hashes) == 9 and all(re.fullmatch(r'[0-9a-f]{64}', row['sha256'])
                        for row in hashes), 'module_hash_schema')
                receipt.update({'passed': True, 'numPassed': count, 'cases': count,
                                'moduleHashes': hashes, 'processGuardEnabled': True,
                                'blockedOperations': 0, 'nativeRTCStubbed': True,
                                'actualCompiledSDK': True, 'actualCompiledWebSocket': mode == 'push',
                                'testHarnessOnlyTranspiled': True})
            except Exception as error:
                allowed = {'docker_operation_failed', 'invalid_image_identity', 'network_not_none',
                           'privileged_container', 'test_process_mismatch', 'packaged_test_timeout',
                           'packaged_test_failed', 'packaged_case_count_mismatch',
                           'unexpected_transport_attempt', 'module_hash_schema'}
                marker = str(error)
                receipt['failureMarker'] = marker if marker in allowed else 'unclassified_fixture_failure'
                receipt['errorType'] = type(error).__name__
                (output / filename).write_text(json.dumps(receipt, indent=2) + '\n')
                raise RuntimeError(receipt['failureMarker']) from None
            finally:
                if created and not inspect(name)['State']['Running']:
                    docker('rm', name)
            (output / filename).write_text(json.dumps(receipt, indent=2) + '\n')
