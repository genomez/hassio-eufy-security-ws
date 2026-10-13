"""Hosted-only default-entrypoint qualification; never prints container logs/options."""
import argparse
import json
import pathlib
import re
import subprocess
from owned_temp import temporary_data
import time
import uuid

ORIGINAL = 'ghcr.io/genomez/eufy-security-ws-rc3-login-retry-amd64@sha256:8cb3d1854beb428803be7e50dcd038faf4b24ed0bfe3c4e7d63b62cec2c67a57'
MISSING = 'Required parameters username and/or password not set. Starting aborted!'
ENVDIR = '/run/s6/container_environment'
CLI = '/usr/src/app/node_modules/eufy-security-ws/dist/bin/server.js'
ALLOWED = {'preloadEntered', 's6EnvironmentPresent', 'launcherBytesVerified', 'actualCliArgvVerified',
           'optionalDiscoveryFallbackVerified',
           'rtcDefaultsVerified', 'launcherConfigVerified', 'fakeInitialize',
           'fakeMegaLogin', 'fakeConnect', 'serverListening', 'readyForStop',
           'sigtermObserved', 'driverClose', 'serverClosed', 'blockedOperation'}
CURRENT_CASE = 'not_started'
CURRENT_PHASE = 'startup'
FAILURE_MARKERS = {
    'docker_operation_failed', 'trace_schema', 'trace_marker_not_allowlisted',
    'default_process_mismatch', 'network_not_none', 'privileged_container',
    'synthetic_exited_before_ready', 'synthetic_readiness_timeout',
    'empty_case_exit_timeout', 'negative_control_exit_not_111',
    'negative_control_expected_envdir_missing', 'negative_control_reached_application',
    'empty_options_exit_not_zero', 'empty_options_missing_refusal_marker',
    'empty_options_node_or_init_failure', 'synthetic_shutdown_failed',
    'node_exit_not_zero', 'unexpected_transport_attempt',
    'required_trace_missing_or_repeated', 'shutdown_trace_order',
    'original_image_not_fixed_digest', 'corrected_image_equals_original',
    'image_identity_not_digest',
    'shell_diagnostic_schema',
    'rtc_binding_override_present',
    'synthetic_temp_scope_invalid',
    'synthetic_temp_ownership_repair_failed',
    'synthetic_temp_cleanup_failed',
}


def docker(*args, timeout=45, combine_logs=False):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('docker_operation_failed')
    if combine_logs:
        require(args and args[0] == 'logs', 'docker_operation_failed')
        return result.stdout + result.stderr
    return result.stdout


def inspect(name):
    return json.loads(docker('inspect', name))[0]


def require(condition, marker):
    if not condition:
        raise AssertionError(marker)


def read_trace(data):
    target = data / 'qualification-trace.json'
    if not target.exists():
        return None
    result = json.loads(target.read_text())
    require(set(result) == {'schema', 'trace', 'blockedOperations', 'exitCode'}, 'trace_schema')
    require(result['schema'] == 1 and isinstance(result['trace'], list), 'trace_schema')
    require(all(event in ALLOWED for event in result['trace']), 'trace_marker_not_allowlisted')
    return result


def failure_marker(error):
    marker = str(error) if isinstance(error, (AssertionError, RuntimeError)) else None
    return marker if marker in FAILURE_MARKERS else 'unclassified_fixture_failure'


def read_shell_diagnostic(data):
    target = data / 'qualification-shell-diagnostic.json'
    if not target.exists():
        return None
    result = json.loads(target.read_text())
    require(set(result) == {'schema', 'exitCode', 'lineNumber', 'stage'}, 'shell_diagnostic_schema')
    require(result['schema'] == 1 and type(result['exitCode']) is int
            and 1 <= result['exitCode'] <= 255 and type(result['lineNumber']) is int
            and result['lineNumber'] >= 0 and result['stage'] in {
                'hostnameDiscovery', 'routeDiscovery', 'bashioConfiguration',
                'jsonGeneration', 'unknown'}, 'shell_diagnostic_schema')
    return result


def startup_markers(logs):
    """Fixed observations only: no arbitrary text, matches, paths or credentials."""
    lowered = logs.lower()
    return {
        'launcherMissingCredentialsMessage': MISSING in logs,
        's6EnvironmentDirectoryMention': ENVDIR in logs,
        's6EnvdirFatalMention': 's6-envdir: fatal:' in lowered,
        's6Stage2FailureMention': bool(re.search(r'stage\s*2[^\n]*(?:fail|error)', lowered)),
        's6ServiceFailureMention': bool(re.search(r'(?:s6-rc|s6-supervise|s6-svscan)[^\n]*(?:fail|fatal|error|unable)', lowered)),
        'serviceCommandExitMention': 'command exited' in lowered,
        's6FatalMention': bool(re.search(r's6[-\w]*:\s*fatal:', lowered)),
        'legacyContInitFailureMention': bool(re.search(r'legacy-cont-init[^\n]*(?:fail|error)', lowered)),
        'fixAttrsFailureMention': bool(re.search(r'fix-attrs[^\n]*(?:fail|error)', lowered)),
        'bashioMention': 'bashio' in lowered,
        'bashioFailureMention': bool(re.search(r'bashio[^\n]*(?:fatal|error|fail)', lowered)),
        'optionsFileMention': '/data/options.json' in logs,
        'configFailureMention': bool(re.search(r'(?:options|configuration|config)[^\n]*(?:not found|missing|error|fail)', lowered)),
        'supervisorTokenMention': 'SUPERVISOR_TOKEN' in logs,
        'supervisorTokenRequiredMention': bool(re.search(r'supervisor_token[^\n]*(?:not set|missing|required|not defined|not found)', lowered)) or 'no supervisor_token' in lowered,
        'supervisorConnectionFailureMention': bool(re.search(r'supervisor[^\n]*(?:connect|refused|unreachable|fail|error)', lowered)),
        'supervisorRequestFailureMention': bool(re.search(r'(?:supervisor|/addons/self/options/config)[^\n]*(?:request|curl|fail|error|missing|unable)', lowered)),
        'supervisorOptionsEndpointMention': '/addons/self/options/config' in logs,
        'curlFailureMention': bool(re.search(r'curl[^\n]*(?:error|fail|could not|couldn.t|unable|\([0-9]+\))', lowered)),
        'hostnameInvalidOptionMention': bool(re.search(r'hostname[^\n]*(?:invalid|unrecognized|unknown|illegal)[^\n]*option', lowered)),
        'permissionDeniedMention': 'permission denied' in lowered,
        'missingFileMention': 'no such file or directory' in lowered,
        'commandNotFoundMention': 'command not found' in lowered,
        'nodeAssertionMention': 'AssertionError' in logs,
        'nodeModuleMissingMention': 'MODULE_NOT_FOUND' in logs or 'ERR_MODULE_NOT_FOUND' in logs,
        'nodeDriverStartFailureMention': 'Unable to start driver' in logs,
        'nodeServerStartFailureMention': 'Unable to start Server' in logs,
        'nodeVersionBannerMention': 'Node.js v' in logs,
        'offlineGuardFailureMention': 'QUALIFICATION_OPERATION_DENIED:' in logs,
    }


def failed_case_receipt(name, mode, data, error, created):
    result = {'case': mode, 'passed': False, 'failureMarker': failure_marker(error),
              'errorType': type(error).__name__, 'rawLogsOmitted': True,
              'syntheticBashioCacheInput': True,
              'exitCode': None, 'oomKilled': None, 'running': None,
              'imageId': None, 'defaultPath': None, 'defaultArgs': None,
              'trace': [], 'startupMarkers': startup_markers(''),
              'shellDiagnostic': None}
    result['forcedTermination'] = None
    if created:
        try:
            current = inspect(name)
            state = current['State']
            result['exitCode'] = state['ExitCode'] if type(state.get('ExitCode')) is int else None
            result['oomKilled'] = state['OOMKilled'] if type(state.get('OOMKilled')) is bool else None
            result['running'] = state['Running'] if type(state.get('Running')) is bool else None
            image_id = current.get('Image')
            if isinstance(image_id, str) and re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
                result['imageId'] = image_id
            if current.get('Path') in ('/init', '/run.sh'):
                result['defaultPath'] = current['Path']
            if current.get('Args') in ([], ['/run.sh']):
                result['defaultArgs'] = current['Args']
            result['startupMarkers'] = startup_markers(docker('logs', name, combine_logs=True))
        except Exception:
            result['diagnosticReadFailed'] = True
    try:
        trace = read_trace(data)
        if trace:
            result['trace'] = trace['trace']
    except Exception:
        result['traceReadFailed'] = True
    try:
        result['shellDiagnostic'] = read_shell_diagnostic(data)
    except Exception:
        result['shellDiagnosticReadFailed'] = True
    return result


def run_case(image, mode, fixtures, root):
    name = 'rc3-init-qualification-' + uuid.uuid4().hex
    data = root / mode
    data.mkdir()
    synthetic_case = mode in ('corrected-synthetic', 'corrected-route-unavailable')
    options = {} if not synthetic_case else {
        'username': 'qualification@example.invalid',
        'password': 'synthetic-only-no-authentication', 'country': 'FR',
        'event_duration': 10, 'polling_interval': 15,
        'trusted_device_name': 'isolated-startup-qualification',
        'accept_invitations': False, 'stations': [], 'debug': False,
        'ipv4first': False, 'rtc_app_live_view_test': False,
    }
    if mode == 'corrected-route-unavailable':
        options['stations'] = [{'serial_number': 'SYNTHETIC_STATION', 'ip_address': '192.0.2.1'}]
    (data / 'options.json').write_text(json.dumps(options))
    # Pinned genuine Bashio reads this documented internal cache key before its
    # Supervisor request. Supply synthetic input, never a Supervisor token/stub.
    cache = data / 'bashio-cache'
    cache.mkdir()
    (cache / 'addons.self.options.config.cache').write_text(json.dumps(options))
    created = False
    try:
        # No command, --entrypoint, host port, socket, auth environment or Supervisor mount.
        docker('create', '--name', name, '--platform', 'linux/amd64', '--network', 'none',
               '--mount', f'type=bind,src={fixtures},dst=/qualification,readonly',
               '--mount', f'type=bind,src={data},dst=/data',
               '--env', 'NODE_OPTIONS=--require=/qualification/preload.cjs',
               '--env', 'BASH_ENV=/qualification/shell-diagnostic.sh',
               '--env', f'QUALIFICATION_CASE={mode}',
               '--env', 'CACHE_DIR=/data/bashio-cache', image)
        created = True
        definition = inspect(name)
        require(isinstance(definition['Image'], str)
                and re.fullmatch(r'sha256:[0-9a-f]{64}', definition['Image']) is not None,
                'image_identity_not_digest')
        expected_path = '/init'
        expected_args = ['/run.sh']
        require(definition['Path'] == expected_path and definition['Args'] == expected_args,
                'default_process_mismatch')
        require(definition['HostConfig']['NetworkMode'] == 'none', 'network_not_none')
        require(not definition['HostConfig']['Privileged'], 'privileged_container')
        if mode != 'original-empty':
            require(not any(value.startswith('RTC_BIND_ADDRESS=')
                            for value in definition['Config'].get('Env', [])),
                    'rtc_binding_override_present')
        docker('start', name)
        deadline = time.monotonic() + 40
        if synthetic_case:
            while time.monotonic() < deadline:
                evidence = read_trace(data)
                if evidence and 'readyForStop' in evidence['trace']:
                    break
                require(inspect(name)['State']['Running'], 'synthetic_exited_before_ready')
                time.sleep(0.2)
            else:
                raise AssertionError('synthetic_readiness_timeout')
            # -1 waits indefinitely instead of falling back to SIGKILL. CLI timeout only
            # limits this caller; a failed fixture leaves its owned container for review.
            docker('stop', '--signal', 'SIGTERM', '--timeout', '-1', name, timeout=40)
        else:
            while inspect(name)['State']['Running'] and time.monotonic() < deadline:
                time.sleep(0.2)
            require(not inspect(name)['State']['Running'], 'empty_case_exit_timeout')
        state = inspect(name)['State']
        logs = docker('logs', name, combine_logs=True)
        evidence = read_trace(data)
        if mode in ('parent-empty', 'corrected-empty'):
            require(state['ExitCode'] == 0, 'empty_options_exit_not_zero')
            require(MISSING in logs, 'empty_options_missing_refusal_marker')
            require('s6-envdir' not in logs and evidence is None, 'empty_options_node_or_init_failure')
        else:
            require(state['ExitCode'] == 0 and not state['OOMKilled'], 'synthetic_shutdown_failed')
            require(evidence is not None and evidence['exitCode'] == 0, 'node_exit_not_zero')
            require(evidence['blockedOperations'] == 0, 'unexpected_transport_attempt')
            required = ALLOWED - {'blockedOperation'}
            require(all(evidence['trace'].count(marker) == 1 for marker in required), 'required_trace_missing_or_repeated')
            require(evidence['trace'].index('readyForStop') < evidence['trace'].index('sigtermObserved')
                    < evidence['trace'].index('driverClose') < evidence['trace'].index('serverClosed'),
                    'shutdown_trace_order')
        return {'case': mode, 'passed': True, 'exitCode': state['ExitCode'],
                'imageId': definition['Image'],
                'defaultPath': definition['Path'], 'defaultArgs': definition['Args'],
                'networkMode': 'none', 'trace': evidence['trace'] if evidence else [],
                'syntheticBashioCacheInput': True,
                'rtcBindingFixtureOverride': False,
                'startupMarkers': startup_markers(logs), 'oomKilled': state['OOMKilled'],
                'shellDiagnostic': read_shell_diagnostic(data),
                'rawLogsOmitted': True, 'forcedTermination': False}
    except Exception as error:
        error.safe_receipt = failed_case_receipt(name, mode, data, error, created)
        raise
    finally:
        if created:
            # Never forcibly remove a running container: preserve failed live evidence.
            if not inspect(name)['State']['Running']:
                docker('rm', name)


def main():
    global CURRENT_CASE, CURRENT_PHASE
    parser = argparse.ArgumentParser()
    parser.add_argument('--original', required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    args = parser.parse_args()
    require(args.original == ORIGINAL, 'original_image_not_fixed_digest')
    require(args.candidate != ORIGINAL, 'corrected_image_equals_original')
    args.output.mkdir(parents=True, exist_ok=True)
    output_dir = args.output
    args.output = output_dir / 'STARTUP_QUALIFICATION.json'
    fixtures = pathlib.Path(__file__).resolve().parent
    results = []
    try:
        with temporary_data('rc3-init-synthetic-', output_dir / 'STARTUP_TEMP_CLEANUP.json') as root:
            for image, mode in [(args.original, 'parent-empty'),
                                (args.candidate, 'corrected-empty'),
                                (args.candidate, 'corrected-synthetic'),
                                (args.candidate, 'corrected-route-unavailable')]:
                CURRENT_CASE = mode
                results.append(run_case(image, mode, fixtures, root))
    except Exception as error:
        if hasattr(error, 'safe_receipt'):
            results.append(error.safe_receipt)
        args.output.write_text(json.dumps({
            'schema': 1, 'passed': False, 'originalImage': ORIGINAL,
            'correctedImage': args.candidate, 'cases': results,
            'failureMarker': failure_marker(error), 'errorType': type(error).__name__,
            'rawLogsOmitted': True, 'realCloudAuthentication': False,
            'productionAccess': False,
        }, indent=2) + '\n')
        raise
    receipt = {'schema': 1, 'passed': True, 'originalImage': ORIGINAL,
               'correctedImage': args.candidate, 'cases': results,
               'realDefaultEntrypoint': True, 'realLauncherAndCli': True,
               'realCloudAuthentication': False, 'productionAccess': False}
    args.output.write_text(json.dumps(receipt, indent=2) + '\n')
    CURRENT_PHASE = 'packaged-runtime'
    CURRENT_CASE = 'packaged-runtime'
    from packaged import run_packaged
    run_packaged(args.candidate, fixtures, output_dir)
    print(json.dumps({'status': 'passed', 'startupCases': len(results), 'pushCases': 20, 'retryCases': 34, 'coordinationCases': 82}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Docker errors/logs or assertion values are never forwarded into receipts.
        print(json.dumps({'status': 'failed', 'errorType': type(error).__name__,
                          'case': CURRENT_CASE, 'phase': CURRENT_PHASE, 'failureMarker': failure_marker(error)}))
        raise SystemExit(1)
