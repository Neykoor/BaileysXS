  <h1 align="center">
 <span style="color:#25D366;">[🟣] Baileysxs</span> <span style="color:#FFFFFF;">WhatsApp Web API</span>
</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Versión-9.6.0-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" />
  <img src="https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/Estado-Beta-FFAA00?style=for-the-badge" />
  <img src="https://img.shields.io/badge/CommonJS-✔-yellow?style=for-the-badge&logo=javascript&logoColor=black" />
</p>

---
⊹ **Baileysxs** es una librería de JavaScript ligera y completa para interactuar con la API Web de WhatsApp mediante WebSocket.

> [!IMPORTANT]  
> Este proyecto es una versión mejorada de Baileys, diseñada específicamente para facilitar el uso y corregir errores comunes en el desarrollo de bots de WhatsApp.

---

## ⟩ Características

- ✅ **Soporte Multi-Dispositivo**
- 🔄 **Mensajería en Tiempo Real** (texto, multimedia, encuestas, botones)
- ✨ **Mensajes Enriquecidos** — tablas, bloques de código con resaltado, citas con fuentes
- 👉🏻 **Mensajes Interactivos** — botones, listas, native flows, plantillas y carruseles
- 🛠️ **Gestión de Grupos y Canales** (crear, modificar, invitar)
- 🔒 **Cifrado de Extremo a Extremo** + **reporting tokens** nativos
- 📦 **Persistencia de Sesiones** (archivos, MongoDB o **SQLite**)

---

## ⟩ Registro de Cambios

### 🆕 v9.6.0 — Mensajes enriquecidos y protocolo

> [!TIP]
> Todo lo nuevo de esta versión está documentado en
> [**✨ Novedades v9.6**](#-novedades-v96).

- ✨ **Rich Response** — mensajes con [tablas](#-tabla), [bloques de código resaltados](#-bloque-de-código) y [citas con fuentes](#-citas-con-fuentes)
- 🎨 **Resaltado de sintaxis** para 25 lenguajes (JS, TS, Python, Go, Rust, C/C++, C#, Bash, CMD, PowerShell, HTML, CSS…)
- 📑 **`spoiler`** — oculta el contenido tras un toque
- 🧾 **`invoiceNote`** — [mensajes de factura](#-factura) con imagen o PDF adjunto
- 🫙 **`interactiveAsTemplate`** — [envuelve un interactivo en plantilla](#-interactivo-como-plantilla)
- 🏷️ **`secureMetaServiceLabel`** — etiqueta de servicio seguro de Meta
- 📣 **`mentionAll`** — menciona a todo el grupo sin listar JIDs
- 🧩 **`raw`** — construye el mensaje manualmente sin transformaciones
- 🔐 **Reporting tokens** — los mensajes salen reportables, igual que WhatsApp Web
- 🗄️ **`useSqliteAuthState`** — sesión en una sola base SQLite en vez de miles de JSON
- 🔁 **`handleIdentityChange`** — refresco inteligente de sesión al reinstalar un contacto
- 🐛 **Arreglado**: `interactiveButtons` sin media lanzaba `Invalid media type`
- 🐛 **Arreglado**: las reacciones y votos ya no incluyen `messageSecret` innecesario

### Versiones anteriores

- 🦖 Mensaje con Logo AI
- 🚀 Limpieza de Buffer del Logger
- 🗄️ Corrección en makeInMemoryStore
- 🍟 Conversión automática de Menciones LID a JID
- 🤖 Conversión de Remitente LID a JID
- 👥 Conversión de ID de Grupo LID a JID
- 🩸 Solución a todos los Bugs LID (participantes, menciones, remitentes, admins)
- 💨 Corrección de Respuesta Lenta
- ⚠️ Botones ContextInfo arreglados según estándares de WhatsApp
- 📣 Soporte completo para Newsletters (Canales)

---

# ⊹ Instalación

> [!NOTE] 
> Copia y pega los comandos en tu terminal.

```bash
npm install github:Ryze/Ryze
```
*O si prefieres yarn:*
```bash
yarn add github:Ryze/Ryze
```

---

# ✜ Inicio Rápido

```javascript
const {
  default: makeWASocket,
  useMultiFileAuthState,
} = require('Ryze');

const {
  state,
  saveCreds
} = await useMultiFileAuthState("./ruta/a/carpeta/sesiones")

/*
 * const sock = makeWASocket({ printQRInTerminal: true });
 * código para obtener la conexión web de WhatsApp
 * disponible código QR o código de emparejamiento
 */

sock.ev.on('messages.upsert', ({ messages }) => {
  console.log('Nuevo mensaje:', messages[0].message);
});
```

---

# ✜ Documentación

### ➤ Conectar Cuenta

<details>
<summary><strong>🔗 Conectar con Código QR</strong></summary>

```javascript
const sock = makeWASocket({
  printQRInTerminal: true, // true para mostrar el código QR
  auth: state
})
```
</details>

<details>
<summary><strong>🔢 Conectar con Código de Emparejamiento</strong></summary>

```javascript
const sock = makeWASocket({
  printQRInTerminal: false, // false para que el código de emparejamiento no se interrumpa
  auth: state
})

if (!sock.authState.creds.registered) {
  const numero = "62xxxx" // Tu número de teléfono

  // usar código de emparejamiento por defecto (RYZEWABI)
  const codigo = await sock.requestPairingCode(numero)

  // usar código personalizado (8 dígitos)
  const codigoPersonalizado = "ABCD4321"
  const codigo = await sock.requestPairingCode(numero, codigoPersonalizado)
  console.log(codigo)
}
```
</details>

<br>

### ➤ Manejo de Eventos

<details>
<summary><strong>📌 Ejemplo para Empezar</strong></summary>

```javascript
sock.ev.on('messages.upsert', ({ messages }) => {
  console.log('Nuevo mensaje:', messages[0].message);
});
```
</details>

<details>
<summary><strong>🗳️ Descifrar Votos de Encuestas</strong></summary>

```javascript
sock.ev.on('messages.update', (m) => {
  if (m.pollUpdates) console.log('Voto de encuesta:', m.pollUpdates);
});
```
</details>

<br>

### ➤ Enviar Mensajes

```javascript
/**
 * Envía un mensaje usando la conexión socket de WhatsApp.
 * 
 * @param {string} jid - El JID (Jabber ID) del destinatario/usuario.
 *                       Es el identificador único para el usuario o grupo de WhatsApp.
 * @param {Object} content - El contenido del mensaje a enviar (texto, imagen, video, etc.).
 * @param {Object} [options] - Parámetros opcionales (citado, efímero, etc.).
 */
const jid = '';        // JID del destinatario
const content = {};     // Objeto del contenido
const options = {};     // Opciones opcionales

// Función base
sock.sendMessage(jid, content, options)
```

<details>
<summary><strong>📝 Mensaje de Texto</strong></summary>

```javascript
// Texto Simple
await sock.sendMessage(jid, { text: '¡Hola!' });
```

```javascript
// Texto con vista previa de enlace
await sock.sendMessage(jid, {
  text: 'Visita https://ejemplo.com',
  linkPreview: {
    'canonical-url': 'https://ejemplo.com',
    title: 'Dominio de Ejemplo',
    description: 'Un sitio web de demostración',
    jpegThumbnail: fs.readFileSync('preview.jpg')
  }
});
```

```javascript
// Con Respuesta Citada (Quoted)
await sock.sendMessage(jid, { text: '¡Hola!' }, { quoted: mensaje });
```
</details>


<details>
<summary><strong>🖼️ Mensaje de Imagen</strong></summary>

```javascript
// Con buffer de archivo local
await sock.sendMessage(jid, { 
  image: fs.readFileSync('imagen.jpg'),
  caption: '¡Mi gato!',
  mentions: ['1234567890@s.whatsapp.net'] // Etiquetar usuarios
});
```

```javascript
// Con URL
await sock.sendMessage(jid, { 
  image: { url: 'https://ejemplo.com/imagen.jpg' },
  caption: 'Imagen descargada'
});
```
</details>

<details>
<summary><strong>🎥 Mensaje de Video</strong></summary>

```javascript
// Con archivo local
await sock.sendMessage(jid, { 
  video: fs.readFileSync('video.mp4'),
  caption: '¡Video divertido!'
});
```

```javascript
// Con URL
await sock.sendMessage(jid, { 
  video: { url: 'https://ejemplo.com/video.mp4' },
  caption: 'Video transmitido'
});
```

```javascript
// Mensaje de "Ver una vez" (View Once)
await sock.sendMessage(jid, {
  video: fs.readFileSync('secreto.mp4'),
  viewOnce: true // Desaparece después de verlo
});
```
</details>

<details>
<summary><strong>🎵 Audio/PTT (Nota de Voz)</strong></summary>

```javascript
// Audio regular (música)
await sock.sendMessage(jid, { 
  audio: fs.readFileSync('audio.mp3'),
  ptt: false 
});
```

```javascript
// Nota de voz (PTT - Push To Talk)
await sock.sendMessage(jid, { 
  audio: fs.readFileSync('voz.ogg'),
  ptt: true, // Aparece como nota de voz
  waveform: [0, 1, 0, 1, 0] // Onda de audio opcional
});
```
</details>

<details>
<summary><strong>👤 Mensaje de Contacto</strong></summary>

```javascript
const vcard = 'BEGIN:VCARD\n' // metadatos de la tarjeta de contacto
  + 'VERSION:3.0\n' 
  + 'FN:Juan Perez\n' // nombre completo
  + 'ORG:Empresa XYZ\n' // organización
  + 'TEL;type=CELL;type=VOICE;waid=521234567890:+52 1 234 567 890\n' // ID + número
  + 'END:VCARD'

await sock.sendMessage(jid, { 
  contacts: { 
    displayName: 'Tu Nombre', 
    contacts: [{ vcard }] 
  }
})
```
</details>

<details>
<summary><strong>💥 Reacciones</strong></summary>

```javascript
await sock.sendMessage(jid, {
  react: {
    text: '👍', // string vacío para quitar la reacción
    key: message.key // clave del mensaje a reaccionar
  }
})
```
</details>

<details>
<summary><strong>📌 Fijar y Mantener Mensajes</strong></summary>

| Tiempo | Segundos        |
|--------|-----------------|
| 24h    | 86.400        |
| 7d     | 604.800       |
| 30d    | 2.592.000     |

```javascript
// Fijar Mensaje
await sock.sendMessage(jid, {
  pin: {
    type: 1, // 1 para fijar, 2 para quitar
    time: 86400,
    key: message.key
  }
})
```

```javascript
// Mantener Mensaje (Keep in Chat)
await sock.sendMessage(jid, {
  keep: {
    key: message.key,
    type: 1 // 1 para mantener, 2 para quitar
  }
})
```
</details>

<details>
<summary><strong>📍 Ubicación</strong></summary>

```javascript
// Ubicación estática
await sock.sendMessage(jid, {
  location: {
    degreesLatitude: 37.422,
    degreesLongitude: -122.084,
    name: 'Sede de Google'
  }
});
```

```javascript
// Ubicación en tiempo real (Live Location)
await sock.sendMessage(jid, {
  location: {
    degreesLatitude: 37.422,
    degreesLongitude: -122.084,
    accuracyInMeters: 10
  },
  live: true, // Habilitar seguimiento en vivo
  caption: '¡Estoy aquí!'
});
```
</details>

<details>
<summary><strong>📞 Llamada</strong></summary>

```javascript
await sock.sendMessage(jid, {
  call: {
    name: 'Mensaje de llamada',
    type: 1 // 1 para audio, 2 para video
  }
})
```
</details>

<details>
<summary><strong>🛒 Pedido (Order)</strong></summary>

```javascript
await sock.sendMessage(jid, {
  order: {
    orderId: '123xxx',
    thumbnail: fs.readFileSync('preview.jpg'),
    itemCount: '123',
    status: 'INQUIRY', // INQUIRY (Consulta) || ACCEPTED (Aceptado) || DECLINED (Rechazado)
    surface: 'CATALOG',
    message: 'Mensaje del pedido',
    orderTitle: 'Título del pedido',
    sellerJid: '628xxx@s.whatsapp.net',
    token: 'token_aqui',
    totalAmount1000: '300000',
    totalCurrencyCode: 'IDR'
  }
})
```
</details>

<details>
<summary><strong>📊 Encuesta</strong></summary>

```javascript
// Crear una encuesta
await sock.sendMessage(jid, {
  poll: {
    name: '¿Color favorito?',
    values: ['Rojo', 'Azul', 'Verde'],
    selectableCount: 1 // 1 para elección única, 0 para múltiple
  }
});
```
</details>

<details>
<summary><strong>👥 Invitación a Grupo</strong></summary>

```javascript
await sock.sendMessage(jid, {
  groupInvite: {
    jid: '123xxx@g.us',
    name: '¡Nombre del Grupo!', 
    caption: 'Invitación para unirte a mi grupo',
    code: 'xYz3yAtf...', // código del enlace de invitación
    expiration: 86400,
    jpegThumbnail: fs.readFileSync('preview.jpg') // opcional            
  }
})
```
</details>

<details>
<summary><strong>↪️ Botones de Respuesta</strong></summary>

```javascript
// Mensaje de Lista (List Message)
await sock.sendMessage(jid, {
  buttonReply: {
    name: 'Hola',
    description: 'descripción', 
    rowId: 'ID'
  }, 
  type: 'list'
})
```

```javascript
// Mensaje de Botón Simple
await sock.sendMessage(jid, {
  buttonReply: {
    displayText: 'Hola', 
    id: 'ID'
  }, 
  type: 'plain'
})
```

```javascript
// Mensaje Interactivo (Native Flow)
await sock.sendMessage(jid, {
  buttonReply: {
    body: 'Hola', 
    nativeFlows: {
      name: 'menu_options', 
      paramsJson: JSON.stringify({ id: 'ID', description: 'descripción' }),
      version: 1 // 2 | 3
    }
  }, 
  type: 'interactive'
})
```
</details>

<details>
<summary><strong>📸 Álbum de Medios</strong></summary>

```javascript
await sock.sendAlbumMessage(jid,
  [{
    image: { url: 'https://ejemplo.com/imagen.jpg' },
    caption: 'Hola Mundo'
  },
  {
    image: fs.readFileSync('imagen.jpg'), 
    caption: 'Hola Mundo'
  },
  {
    video: { url: 'https://ejemplo.com/video.mp4' },
    caption: 'Hola Mundo'
  }],
{ quoted: mensaje, delay: 3000 })
```
</details>

<details>
<summary><strong>👨‍💻 Mensajes Interactivos (Avanzado)</strong></summary>

> Estos mensajes simulan interacciones empresariales avanzadas.

<details>
<summary><strong>Mensaje tipo Tienda (Shop)</strong></summary>

```javascript
// Encabezado de Imagen
await sock.sendMessage(jid, { 
  image: {
    url: 'https://www.ejemplo.com/imagen.jpg'
  },    
  caption: 'Cuerpo del mensaje',
  title: 'Título', 
  subtitle: 'Subtítulo', 
  footer: '© Ryze',
  shop: {
    surface: 1, // 2 | 3 | 4
    id: 'nombre_tienda_facebook'
  }, 
  hasMediaAttachment: true,
  viewOnce: true
})
```
</details>

<details>
<summary><strong>Mensaje Carrusel</strong></summary>
Muestra tarjetas deslizables.

```javascript
await sock.sendMessage(jid, {
  text: 'Cuerpo del mensaje',
  title: 'Título', 
  footer: '© Ryze',
  cards: [{
    image: { url: 'https://www.ejemplo.com/imagen.jpg' },
    title: 'Título tarjeta 1',
    body: 'Cuerpo tarjeta 1',
    footer: '© Ryze',
    buttons: [{
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({
        display_text: 'Ver Más',
        id: '123'
      })
    }]
  }]
})
```
</details>

<details>
<summary><strong>Flujo Nativo (Native Flow Buttons)</strong></summary>

```javascript
// Botón de URL
const native_flow_button = [{
  name: 'cta_url',
  buttonParamsJson: JSON.stringify({
    display_text: 'Visitar Sitio',
    url: 'https://www.ejemplo.com',
    merchant_url: 'https://www.ejemplo.com'
  })
}]

// Botón de Copiar
const native_flow_button_copy = [{
  name: 'cta_copy',
  buttonParamsJson: JSON.stringify({
    display_text: 'Copiar Código',
    copy_code: '12345678'
  })
}]

// Enviar el mensaje con los botones
await sock.sendMessage(jid, {
  text: '¡Elige una opción!',
  title: 'Menú Interactivo',
  footer: '© Ryze',
  interactive: native_flow_button
})
```
</details>
</details>

<br>

### ✨ Novedades v9.6

> [!NOTE]
> Todas estas opciones se pasan dentro del objeto `content` de `sock.sendMessage(jid, content)`.

<details open>
<summary><strong>📋 Tabla</strong></summary>

Envía una tabla real renderizada por WhatsApp. La primera fila es el encabezado
salvo que pases `noHeading: true`.

```javascript
await sock.sendMessage(jid, {
  title: 'Ventas del mes',
  table: [
    ['Producto', 'Cantidad', 'Total'],
    ['Camisetas', '120', '$2,400'],
    ['Gorras',    '45',  '$675'],
    ['Tazas',     '80',  '$960']
  ]
})

// Sin fila de encabezado
await sock.sendMessage(jid, {
  table: [['A', '1'], ['B', '2']],
  noHeading: true
})
```
</details>

<details>
<summary><strong>🧾 Bloque de Código</strong></summary>

El código se tokeniza y se envía ya resaltado. Si omites `language`, se usa `javascript`.

```javascript
await sock.sendMessage(jid, {
  headerText: 'Ejemplo en Python',
  code: `def saludar(nombre):
    # esto es un comentario
    return f"Hola {nombre}"`,
  language: 'python',
  footerText: 'Generado con Ryzewa'
})
```

**Lenguajes soportados:**

| | | | |
|---|---|---|---|
| `javascript` / `js` | `typescript` / `ts` | `python` / `py` | `go` / `golang` |
| `rust` / `rs` | `c` / `h` | `cpp` / `c++` | `csharp` / `cs` |
| `bash` / `sh` / `zsh` | `cmd` / `bat` | `powershell` / `ps1` | `html` / `css` |

</details>

<details>
<summary><strong>🌏 Citas con Fuentes</strong></summary>

Añade referencias numeradas al estilo de las respuestas de IA.

```javascript
await sock.sendMessage(jid, {
  links: [
    {
      text: 'La capital de Francia es París',
      url: 'https://es.wikipedia.org/wiki/París',
      title: 'París — Wikipedia',
      displayName: 'Wikipedia',
      sources: [
        { displayName: 'Wikipedia', subtitle: 'Enciclopedia libre', url: 'https://es.wikipedia.org' }
      ]
    }
  ]
})
```
</details>

<details>
<summary><strong>✨ Rich Response (por secciones)</strong></summary>

Para combinar varios bloques en un mismo mensaje, usa el array `richResponse`.
Cada elemento es una sección independiente.

```javascript
await sock.sendMessage(jid, {
  richResponse: [
    { text: '**Reporte diario**' },
    { code: 'SELECT * FROM ventas WHERE dia = HOY;', language: 'sql' },
    {
      title: 'Resumen',
      table: [
        { isHeading: true, items: ['Métrica', 'Valor'] },
        { isHeading: false, items: ['Pedidos', '245'] },
        { isHeading: false, items: ['Ingresos', '$4,035'] }
      ]
    },
    { text: '_Actualizado hace 5 minutos_' }
  ],
  disclaimerText: 'Datos generados automáticamente'
})
```

**Tipos de sección disponibles:** `text`, `code`, `table`, `items`, `inlineImage`, `latex`.
</details>

<details>
<summary><strong>📑 Spoiler</strong></summary>

Oculta el contenido hasta que el receptor lo toca. Funciona con texto y con multimedia.

```javascript
await sock.sendMessage(jid, {
  image: { url: './final-pelicula.jpg' },
  caption: '¡No mires si no la has visto!',
  spoiler: true
})

await sock.sendMessage(jid, { text: 'El mayordomo fue', spoiler: true })
```
</details>

<details>
<summary><strong>🧾 Factura</strong></summary>

Convierte una imagen o un PDF ya adjunto en un mensaje de factura nativo.

```javascript
// Factura con imagen
await sock.sendMessage(jid, {
  image: { url: './factura.jpg' },
  invoiceNote: 'Factura #00123 — Total: $450.00'
})

// Factura con PDF
await sock.sendMessage(jid, {
  document: { url: './factura.pdf' },
  mimetype: 'application/pdf',
  fileName: 'factura-00123.pdf',
  invoiceNote: 'Factura #00123'
})
```

> [!WARNING]
> `invoiceNote` requiere obligatoriamente un `image` o un `document`. Sin adjunto lanza error.
</details>

<details>
<summary><strong>🫙 Interactivo como Plantilla</strong></summary>

Envuelve un `interactiveMessage` dentro de un `templateMessage`. Útil cuando el
cliente destino renderiza mejor las plantillas.

```javascript
await sock.sendMessage(jid, {
  text: '¿Confirmas tu pedido?',
  footer: '© Ryzewa',
  interactiveButtons: [
    {
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: 'Confirmar', id: 'ok' })
    }
  ],
  interactiveAsTemplate: true,
  id: 'pedido-123'   // opcional: templateId personalizado
})
```
</details>

<details>
<summary><strong>📣 Mencionar a Todos</strong></summary>

```javascript
// Menciona a todo el grupo — sin necesidad de listar los JIDs
await sock.sendMessage(groupJid, {
  text: '¡Reunión en 10 minutos!',
  mentionAll: true
})
```
</details>

<details>
<summary><strong>🏷️ Etiqueta de Servicio Seguro</strong></summary>

Añade la etiqueta de servicio seguro de Meta al mensaje.

```javascript
await sock.sendMessage(jid, {
  text: 'Tu código de verificación es 123456',
  secureMetaServiceLabel: true
})
```
</details>

<details>
<summary><strong>🐱 Sticker Lottie</strong></summary>

```javascript
await sock.sendMessage(jid, {
  sticker: { url: './animado.webp' },
  isLottie: true
})
```
</details>

<details>
<summary><strong>🧩 Mensaje Crudo (raw)</strong></summary>

Construye el protobuf a mano, sin que Ryzewa lo transforme. Para casos avanzados.

```javascript
await sock.sendMessage(jid, {
  raw: true,
  extendedTextMessage: {
    text: 'Mensaje construido manualmente',
    contextInfo: { isForwarded: true, forwardingScore: 99 }
  }
})
```

> [!CAUTION]
> `raw` desactiva todas las validaciones. Úsalo solo si sabes exactamente qué estás enviando.
</details>

<br>

### ➤ Sesión en SQLite

En bots con mucho tráfico, `useMultiFileAuthState` genera miles de archivos JSON.
`useSqliteAuthState` guarda todo en una sola base con índices — mucho menos I/O.

```bash
npm install better-sqlite3
```

```javascript
const { useSqliteAuthState } = require('ryzewa')

const { state, saveCreds, clearKeys, close } = await useSqliteAuthState({
  dbPath: './sesion.db'
})

const sock = makeWASocket({ auth: state })
sock.ev.on('creds.update', saveCreds)

// await clearKeys()  // borra las claves Signal conservando las credenciales
// close()            // cierra la base de datos
```

También puedes pasar una instancia ya abierta con `{ database: miDb }`.

<br>

### ➤ Utilidades Nuevas

<details>
<summary><strong>🎨 tokenizeCode — resaltado manual</strong></summary>

```javascript
const { tokenizeCode, CodeHighlightType } = require('ryzewa')

const tokens = tokenizeCode('const x = 42 // hola', 'javascript')
// [{ highlightType: 1, codeContent: 'const' }, ...]
// 0=DEFAULT 1=KEYWORD 2=METHOD 3=STRING 4=NUMBER 5=COMMENT
```
</details>

<details>
<summary><strong>🔐 Reporting Tokens</strong></summary>

Ryzewa adjunta automáticamente el `reporting_token` a cada mensaje saliente,
igual que WhatsApp Web, para que el receptor pueda reportarlo. No hay que
configurar nada, pero las funciones están expuestas:

```javascript
const { shouldIncludeReportingToken, getMessageReportingToken } = require('ryzewa')

shouldIncludeReportingToken({ conversation: 'hola' })      // true
shouldIncludeReportingToken({ reactionMessage: {} })       // false
```
</details>

<details>
<summary><strong>🔁 handleIdentityChange</strong></summary>

Decide si hay que refrescar la sesión Signal cuando un contacto reinstala
WhatsApp. Ignora dispositivos companion, la identidad propia, notificaciones
offline y contactos sin sesión previa.

```javascript
const { handleIdentityChange } = require('ryzewa')

const resultado = await handleIdentityChange(node, {
  logger,
  meId: sock.user.id,
  meLid: sock.user.lid,
  debounceCache,
  validateSession: jid => ({ exists: true }),
  assertSessions: sock.assertSessions
})
// resultado.action: 'session_refreshed' | 'debounced' | 'skipped_no_session' | ...
```
</details>

<details>
<summary><strong>📨 buildAckStanza</strong></summary>

```javascript
const { buildAckStanza } = require('ryzewa')

const ack  = buildAckStanza(node, undefined, sock.user.id)  // ACK
const nack = buildAckStanza(node, 500, sock.user.id)        // NACK con error
```
</details>

<br>

### ➤ Canales (Newsletter)

<details>
<summary><strong>📋 Metadatos del Canal</strong></summary>

```javascript
// Usar código de invitación (sin url)
const newsletter = await sock.newsletterMetadata("invite", "0029Vaf0HPMLdQeZsp3XRp2T")
console.log("Metadatos:", newsletter)
```
</details>

<details>
<summary><strong>👥 Seguir / Dejar de Seguir</strong></summary>

```javascript
// Seguir
await sock.newsletterFollow("120363282083849178@newsletter")

// Dejar de seguir
await sock.newsletterUnfollow("120363282083849178@newsletter")
```
</details>

<details>
<summary><strong>🔈 Silenciar / Des-silenciar</strong></summary>

```javascript
await sock.newsletterMute("120363282083849178@newsletter")
await sock.newsletterUnmute("120363282083849178@newsletter")
```
</details>

<details>
<summary><strong>📣 Crear Canal</strong></summary>

```javascript
const newsletter = await sock.newsletterCreate(
  "¡Nombre del Canal!", 
  "¡Descripción aquí!", 
  { url: 'https://ejemplo.com/imagen.jpg' }
)
console.log("Datos del nuevo canal:", newsletter)
```
</details>

<br>

### ➤ Gestión de Grupos

<details>
<summary><strong>🔄 Crear Grupo</strong></summary>

```javascript
const group = await sock.groupCreate("Título del Grupo", ["123@s.whatsapp.net", "456@s.whatsapp.net"]);
console.log("Grupo creado:", group)
```
</details>

<details>
<summary><strong>💯 Añadir, Eliminar, Promover, Degrad</strong></summary>

```javascript
// añadir miembro
await sock.groupParticipantsUpdate(jid, ['usuario@s.whatsapp.net'], 'add')

// eliminar miembro
await sock.groupParticipantsUpdate(jid, ['usuario@s.whatsapp.net'], 'remove')

// promover a admin
await sock.groupParticipantsUpdate(jid, ['usuario@s.whatsapp.net'], 'promote')

// degradar (quitar admin)
await sock.groupParticipantsUpdate(jid, ['usuario@s.whatsapp.net'], 'demote')
```
</details>

<details>
<summary><strong>⚙️ Ajustes del Grupo</strong></summary>

```javascript
// solo admins envían mensajes
await sock.groupSettingUpdate(jid, 'announcement')

// todos envían mensajes
await sock.groupSettingUpdate(jid, 'not_announcement')
```
</details>

<br>

### ➤ Privacidad

<details>
<summary><strong>🚫 Bloquear/Desbloquear</strong></summary>

```javascript
// Bloquear
await sock.updateBlockStatus(jid, 'block');

// Desbloquear
await sock.updateBlockStatus(jid, 'unblock');
```
</details>

<details>
<summary><strong>👀 Última Vez (Last Seen)</strong></summary>

```javascript
// Todos
await sock.updateLastSeenPrivacy("all")
// Nadie
await sock.updateLastSeenPrivacy("none")
```
</details>

<details>
<summary><strong>👁️ Confirmación de Lectura (Blue Ticks)</strong></summary>

```javascript
// Mostrar
await sock.updateReadReceiptsPrivacy("all")
// Ocultar
await sock.updateReadReceiptsPrivacy("none")
```
</details>

<br>

### ➤ Avanzado

<details>
<summary><strong>🔧 Logs de Depuración</strong></summary>

```javascript
const sock = makeWASocket({ logger: { level: 'debug' } });
```
</details>

---

## 🐣 Autor [ Editor ]

<p align="center">
  <img src="https://github.com/Neykoor.png" width="120" height="120" alt="Neykoor" style="border-radius: 50%;" />
  <br>
  <strong>Neykoor</strong>
</p>

---

## ✰ Licencia

Este proyecto está licenciado para **uso personal y no comercial únicamente**.  
Se permite la redistribución, modificación o renombrado para propósitos personales.  
**El uso comercial, reventa está estrictamente prohibido.**

Derechos reservados por **Neykoor**.
