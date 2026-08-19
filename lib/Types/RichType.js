"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

/**
 * Tipos de resaltado usados en los bloques de código (`richResponse` con `code`).
 * Cada token del código se etiqueta con uno de estos valores.
 */
const CodeHighlightType = {
    DEFAULT: 0,
    KEYWORD: 1,
    METHOD: 2,
    STRING: 3,
    NUMBER: 4,
    COMMENT: 5
}
// índice inverso (0 -> 'DEFAULT'), necesario para serializar el unifiedResponse
for (const key of Object.keys(CodeHighlightType)) {
    CodeHighlightType[CodeHighlightType[key]] = key
}

/**
 * Tipos de sub-mensaje que puede contener un `richResponseMessage`.
 */
const RichSubMessageType = {
    UNKNOWN: 0,
    GRID_IMAGE: 1,
    TEXT: 2,
    INLINE_IMAGE: 3,
    TABLE: 4,
    CODE: 5,
    DYNAMIC: 6,
    MAP: 7,
    LATEX: 8,
    CONTENT_ITEMS: 9
}
for (const key of Object.keys(RichSubMessageType)) {
    RichSubMessageType[RichSubMessageType[key]] = key
}

exports.CodeHighlightType = CodeHighlightType
exports.RichSubMessageType = RichSubMessageType
