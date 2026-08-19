"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const package_json_1 = require("../../package.json")

exports.RYZEWA_LOGO = [
    '               ⠠⡀ ⡀',
    '              ⠱⣄⠘⣆',
    '      ⣀  ⢢⣤⣀⣦⣄⡀⠙⣶⡘⢷⣄',
    '    ⣀⣀⣨⣿⣿⣿⣿⣿⣿⣿⣿⣷⣿⣿⣯⣿⣷⣄',
    '   ⢀⣽⣿⣿⣿⣿⠟⠛⠛⠛⠛⠻⢿⣿⣿⣿⣿⣿⣿⣷⣄',
    '  ⠘⣻⣿⣿⡿⠋        ⠈⠙⢿⣿⣿⣿⣿⢿⣷⡀',
    '  ⣴⣿⣿⣿⡇            ⠙⣿⣿⣿⣷⣽⣷⣄',
    '   ⣾⣿⣿⣇             ⠈⠛⢿⣿⣿⣿⣯⠁',
    '  ⠐⠛⢿⣿⣿⣦⡀              ⠉⠻⣿⣿⣷⣄⡀',
    '    ⠘⠟⠿⣿⣿⣦⣀              ⠈⢿⣿⣿⠇',
    '       ⠈⠙⠻⣿⣷⣦⣄⡀           ⡼⠟⠋',
    '           ⠈⠙⠻⢿⣷⣶⣄',
    '               ⠈⠙⠻⣿⣦⡀',
    '                   ⠙⢿⡄',
    '                     ⢻⡄',
    '                     ⠈⡇'
]

// violeta -> cyan, el degradado recorre el logo de arriba a abajo
const GRADIENT_FROM = [167, 85, 247]
const GRADIENT_TO = [34, 211, 238]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const supportsColor = stream => {
    if (process.env.NO_COLOR || process.env.NODE_DISABLE_COLORS) {
        return false
    }

    if (process.env.FORCE_COLOR) {
        return true
    }

    return !!stream.isTTY
}

const paint = (text, t) => {
    const [r, g, b] = GRADIENT_FROM.map((from, i) => Math.round(from + (GRADIENT_TO[i] - from) * t))
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`
}

const buildLines = version => [
    '',
    ...exports.RYZEWA_LOGO,
    '',
    `   R Y Z E W A   v${version}`,
    '   fork de Baileys · github.com/Davizuni17/Ryzewa',
    ''
]

let alreadyPrinted = false

/**
 * Dibuja el logo de Ryzewa linea por linea al arrancar el socket.
 *
 * @param {object} [options]
 * @param {string} [options.version] version a mostrar (por defecto la del package.json)
 * @param {NodeJS.WriteStream} [options.stream] destino de la salida (por defecto stdout)
 * @param {boolean} [options.animate] forzar/desactivar la animacion
 * @param {number} [options.frameMs] milisegundos entre lineas
 * @param {boolean} [options.once] si es false permite reimprimirlo en el mismo proceso
 * @returns {Promise<void>}
 */
exports.printBanner = async (options = {}) => {
    const {
        version = package_json_1.version,
        stream = process.stdout,
        frameMs = 45,
        once = true
    } = options

    // sin este guard cada reconexion que reconstruye el socket repetiria el logo
    if (once && alreadyPrinted) {
        return
    }

    alreadyPrinted = true

    // fuera de una TTY (pm2, docker logs, salida redirigida a un archivo) la
    // animacion solo produciria ruido: se escribe todo de una vez.
    const animate = options.animate !== undefined ? options.animate : !!stream.isTTY
    const color = supportsColor(stream)
    const lines = buildLines(version)

    for (let i = 0; i < lines.length; i++) {
        const t = i / (lines.length - 1)
        stream.write((color ? paint(lines[i], t) : lines[i]) + '\n')

        if (animate) {
            await sleep(frameMs)
        }
    }
}
