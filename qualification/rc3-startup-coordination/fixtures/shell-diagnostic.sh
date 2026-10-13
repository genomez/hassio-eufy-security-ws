# Diagnostic input for noninteractive Bash only. No launcher/function replacement.
# BASH_COMMAND is classified internally and is never printed, persisted or evaluated.
__qualification_shell_err() {
    local original_status="$1" original_line="$2" original_command="$3"
    local fixed_stage="unknown" temporary="/data/qualification-shell-diagnostic.json.tmp.$$"
    case "$original_status" in ''|*[!0-9]*) original_status=1 ;; esac
    case "$original_line" in ''|*[!0-9]*) original_line=0 ;; esac
    case "$original_command" in
        *hostname*) fixed_stage="hostnameDiscovery" ;;
        *'ip -4 route get'*) fixed_stage="routeDiscovery" ;;
        *'bashio::config'*) fixed_stage="bashioConfiguration" ;;
        *'jq -n'*|*JSON_STRING*) fixed_stage="jsonGeneration" ;;
    esac
    printf '{"schema":1,"exitCode":%s,"lineNumber":%s,"stage":"%s"}\n' \
        "$original_status" "$original_line" "$fixed_stage" > "$temporary"
    mv "$temporary" /data/qualification-shell-diagnostic.json
    return "$original_status"
}
trap '__qualification_shell_err "$?" "$LINENO" "$BASH_COMMAND"' ERR
