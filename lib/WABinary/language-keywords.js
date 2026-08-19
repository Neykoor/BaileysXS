"use strict"

// ===== Palabras clave de lenguajes para resaltado de sintaxis (code blocks) =====
const CPP_KEYWORDS = new Set([
    'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor', 'bool', 'break', 'case',
    'catch', 'char', 'class', 'compl', 'concept', 'const', 'consteval', 'constexpr', 'constinit',
    'const_cast', 'continue', 'co_await', 'co_return', 'co_yield', 'decltype', 'default', 'delete',
    'do', 'double', 'dynamic_cast', 'else', 'enum', 'explicit', 'export', 'extern', 'false', 'float',
    'for', 'friend', 'goto', 'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept',
    'not', 'not_eq', 'nullptr', 'operator', 'or', 'or_eq', 'private', 'protected', 'public', 'register',
    'reinterpret_cast', 'requires', 'return', 'short', 'signed', 'sizeof', 'static', 'static_assert',
    'static_cast', 'struct', 'switch', 'template', 'this', 'thread_local', 'throw', 'true', 'try',
    'typedef', 'typeid', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile',
    'wchar_t', 'while', 'xor', 'xor_eq'
]);
const CSS_KEYWORDS = new Set([
    'import', 'media', 'font-face', 'keyframes', 'supports', 'charset',
    'important', 'root', 'hover', 'active', 'focus', 'visited', 'before', 'after',
    'not', 'nth-child', 'first-child', 'last-child', 'only-child',
    'none', 'inherit', 'initial', 'unset', 'auto', 'transparent', 'currentcolor'
]);
const GO_KEYWORDS = new Set([
    'break', 'default', 'func', 'interface', 'select', 'case', 'defer', 'go', 'map', 'struct',
    'chan', 'else', 'goto', 'package', 'switch', 'const', 'fallthrough', 'if', 'range', 'type',
    'continue', 'for', 'import', 'return', 'var', 'true', 'false', 'nil'
]);
const HTML_KEYWORDS = new Set([
    'html', 'head', 'body', 'title', 'meta', 'link', 'script', 'style',
    'header', 'footer', 'main', 'section', 'article', 'aside', 'nav',
    'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'img',
    'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'thead', 'tbody',
    'form', 'input', 'button', 'select', 'textarea', 'label', 'option',
    'canvas', 'svg', 'iframe', 'video', 'audio', 'source'
]);
const JS_KEYWORDS = new Set([
    'import', 'export', 'from', 'default', 'as',
    'const', 'let', 'var', 'function', 'class', 'extends', 'new',
    'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
    'try', 'catch', 'finally', 'throw',
    'async', 'await', 'yield',
    'typeof', 'instanceof', 'in', 'of', 'delete', 'void',
    'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
    'this', 'super', 'static', 'get', 'set',
    'debugger', 'with'
]);
const PYTHON_KEYWORDS = new Set([
    'import', 'from', 'as', 'def', 'class', 'return', 'if', 'elif', 'else',
    'for', 'while', 'break', 'continue', 'try', 'except', 'finally', 'raise',
    'with', 'yield', 'lambda', 'pass', 'del', 'global', 'nonlocal', 'assert',
    'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is', 'async', 'await',
    'self', 'print'
]);
const RUST_KEYWORDS = new Set([
    'as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern',
    'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match',
    'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self',
    'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe',
    'use', 'where', 'while', 'async', 'await', 'dyn',
    'abstract', 'become', 'box', 'do', 'final', 'macro',
    'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield',
    'try'
]);
const C_KEYWORDS = new Set([
    'auto', 'break', 'case', 'char', 'const', 'continue',
    'default', 'do', 'double', 'else', 'enum', 'extern',
    'float', 'for', 'goto', 'if', 'inline', 'int',
    'long', 'register', 'restrict', 'return', 'short',
    'signed', 'sizeof', 'static', 'struct', 'switch',
    'typedef', 'union', 'unsigned', 'void', 'volatile',
    'while',
    '_Alignas', '_Alignof', '_Atomic', '_Bool',
    '_Complex', '_Generic', '_Imaginary',
    '_Noreturn', '_Static_assert', '_Thread_local'
]);
const CSHARP_KEYWORDS = new Set([
    'abstract', 'as', 'base', 'bool', 'break', 'byte',
    'case', 'catch', 'char', 'checked', 'class',
    'const', 'continue', 'decimal', 'default',
    'delegate', 'do', 'double', 'else', 'enum',
    'event', 'explicit', 'extern', 'false', 'finally',
    'fixed', 'float', 'for', 'foreach', 'goto',
    'if', 'implicit', 'in', 'int', 'interface',
    'internal', 'is', 'lock', 'long', 'namespace',
    'new', 'null', 'object', 'operator', 'out',
    'override', 'params', 'private', 'protected',
    'public', 'readonly', 'ref', 'return', 'sbyte',
    'sealed', 'short', 'sizeof', 'stackalloc',
    'static', 'string', 'struct', 'switch',
    'this', 'throw', 'true', 'try', 'typeof',
    'uint', 'ulong', 'unchecked', 'unsafe',
    'ushort', 'using', 'virtual', 'void',
    'volatile', 'while',
    'async', 'await', 'record', 'init',
    'required', 'file', 'global', 'nameof',
    'var', 'dynamic', 'partial', 'yield',
    'from', 'where', 'select', 'group',
    'orderby', 'join', 'let', 'into',
    'equals', 'by', 'ascending', 'descending'
]);
const BASH_KEYWORDS = new Set([
    'if', 'then', 'else', 'elif', 'fi',
    'case', 'esac', 'for', 'while',
    'until', 'do', 'done', 'in',
    'function', 'select', 'time',
    'coproc',
    'echo', 'printf', 'read', 'cd',
    'pwd', 'exit', 'export', 'unset',
    'alias', 'unalias', 'source',
    'exec', 'eval', 'test', 'shift',
    'trap', 'wait', 'jobs', 'kill',
    'bg', 'fg', 'history', 'type',
    'ulimit', 'umask', 'set',
    'true', 'false'
]);
const CMD_KEYWORDS = new Set([
    'echo', 'set', 'if', 'else',
    'for', 'in', 'do', 'goto',
    'call', 'exit', 'shift',
    'pause', 'start', 'title',
    'cls', 'rem',
    'dir', 'copy', 'move', 'del',
    'mkdir', 'rmdir', 'type',
    'ren', 'tasklist', 'taskkill',
    'ping', 'ipconfig', 'netstat',
    'shutdown'
]);
const POWERSHELL_KEYWORDS = new Set([
    'function', 'filter', 'param',
    'begin', 'process', 'end',
    'if', 'else', 'elseif',
    'switch', 'foreach', 'for',
    'while', 'do', 'until',
    'break', 'continue', 'return',
    'throw', 'trap', 'try',
    'catch', 'finally',
    '$true', '$false', '$null',
    'Write-Host', 'Write-Output',
    'Get-Item', 'Set-Item',
    'Get-ChildItem', 'Remove-Item',
    'Copy-Item', 'Move-Item',
    'Test-Path', 'Invoke-Command'
]);
const LANGUAGE_KEYWORDS = {
    css: CSS_KEYWORDS,
    html: HTML_KEYWORDS,
    javascript: JS_KEYWORDS,
    typescript: JS_KEYWORDS,
    js: JS_KEYWORDS,
    ts: JS_KEYWORDS,
    python: PYTHON_KEYWORDS,
    py: PYTHON_KEYWORDS,
    go: GO_KEYWORDS,
    golang: GO_KEYWORDS,
    cpp: CPP_KEYWORDS,
    'c++': CPP_KEYWORDS,
    rust: RUST_KEYWORDS,
    rs: RUST_KEYWORDS,
    c: C_KEYWORDS,
    h: C_KEYWORDS,
    csharp: CSHARP_KEYWORDS,
    cs: CSHARP_KEYWORDS,
    bash: BASH_KEYWORDS,
    sh: BASH_KEYWORDS,
    zsh: BASH_KEYWORDS,
    cmd: CMD_KEYWORDS,
    bat: CMD_KEYWORDS,
    powershell: POWERSHELL_KEYWORDS,
    ps1: POWERSHELL_KEYWORDS
};

module.exports = {
    CPP_KEYWORDS, CSS_KEYWORDS, GO_KEYWORDS, HTML_KEYWORDS, JS_KEYWORDS, PYTHON_KEYWORDS,
    RUST_KEYWORDS, C_KEYWORDS, CSHARP_KEYWORDS, BASH_KEYWORDS, CMD_KEYWORDS,
    POWERSHELL_KEYWORDS, LANGUAGE_KEYWORDS
}
