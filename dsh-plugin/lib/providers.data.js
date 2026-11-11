/**
 * 自动生成，请勿手改。
 *
 * 真源：shared/providers.json
 * 生成：node tools/gen-providers.mjs（校验：node tools/gen-providers.mjs --check）
 * 宿主：DSH 插件
 */

export const DEFAULT_PROVIDER_ID = "deepseek"

export const GENERIC_COMPOSER_SELECTORS = [
  "textarea",
  "textarea[placeholder]",
  "div[contenteditable=\"true\"]",
  "p[contenteditable=\"true\"]",
  "[contenteditable=\"true\"]",
  "[role=\"textbox\"]"
]

export const GENERIC_SEND_ARIA_LABELS = [
  "发送",
  "send",
  "submit",
  "提交"
]

export const PROVIDERS = [
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "url": "https://chat.deepseek.com/",
    "origins": [
      "chat.deepseek.com",
      "deepseek.com"
    ],
    "composerSelectors": [
      "textarea[name=\"search\"]",
      "textarea",
      "div[contenteditable=\"true\"]",
      "p[contenteditable=\"true\"]",
      "[contenteditable=\"true\"]",
      "[role=\"textbox\"]",
      "[data-testid=\"chat-input\"] textarea",
      "[data-testid=\"chat-input\"] [contenteditable=\"true\"]",
      "textarea[data-testid]",
      "[data-testid*=\"input\"] textarea",
      "[data-testid*=\"input\"] [contenteditable=\"true\"]",
      "[data-testid=\"chat-input\"]"
    ],
    "sendSelectors": [],
    "sendClassHints": [
      "ds-button--primary",
      "ds-button--circle"
    ],
    "sendSvgPaths": [
      "M8.3125"
    ],
    "sendAriaLabels": [],
    "enterSends": false,
    "loginMarkers": [
      "sign_in",
      "signin",
      "login"
    ],
    "verifyUrlRegex": "^https?://chat\\.deepseek\\.com/",
    "prefillParam": "q",
    "upload": true
  },
  {
    "id": "qwen",
    "name": "千问 Qwen",
    "url": "https://www.qianwen.com/",
    "origins": [
      "qianwen.com",
      "qianwen.aliyun.com",
      "chat.qwen.ai",
      "tongyi.aliyun.com",
      "tongyi.com"
    ],
    "composerSelectors": [
      "textarea[placeholder]",
      "textarea",
      "[contenteditable=\"true\"][role=\"textbox\"]",
      "[contenteditable=\"true\"]",
      "[role=\"textbox\"]"
    ],
    "sendSelectors": [],
    "sendClassHints": [],
    "sendSvgPaths": [],
    "sendAriaLabels": [
      "发送",
      "Send",
      "Submit"
    ],
    "enterSends": false,
    "loginMarkers": [
      "login",
      "signin",
      "passport",
      "sso"
    ],
    "verifyUrlRegex": "^https?://((www\\.)?qianwen\\.com|qianwen\\.aliyun\\.com|chat\\.qwen\\.ai|tongyi\\.aliyun\\.com|(www\\.)?tongyi\\.com)/",
    "prefillParam": "",
    "upload": true
  },
  {
    "id": "doubao",
    "name": "豆包 Doubao",
    "url": "https://www.doubao.com/chat/",
    "origins": [
      "doubao.com"
    ],
    "composerSelectors": [
      "[data-testid=\"chat_input_input\"]",
      "textarea[placeholder]",
      "textarea",
      "[contenteditable=\"true\"][role=\"textbox\"]",
      "[contenteditable=\"true\"]",
      "[role=\"textbox\"]"
    ],
    "sendSelectors": [],
    "sendClassHints": [],
    "sendSvgPaths": [],
    "sendAriaLabels": [
      "发送",
      "Send",
      "Submit"
    ],
    "enterSends": false,
    "loginMarkers": [
      "login",
      "signin",
      "passport",
      "sso"
    ],
    "verifyUrlRegex": "^https?://(www\\.)?doubao\\.com/",
    "prefillParam": "",
    "upload": true
  },
  {
    "id": "chatgpt",
    "name": "ChatGPT",
    "url": "https://chatgpt.com/",
    "origins": [
      "chatgpt.com",
      "chat.openai.com"
    ],
    "composerSelectors": [
      "#prompt-textarea",
      "textarea#prompt-textarea",
      "div#prompt-textarea[contenteditable=\"true\"]"
    ],
    "sendSelectors": [
      "button[data-testid=\"send-button\"]",
      "button#composer-submit-button"
    ],
    "sendClassHints": [],
    "sendSvgPaths": [],
    "sendAriaLabels": [
      "Send prompt",
      "Send message",
      "发送"
    ],
    "enterSends": false,
    "loginMarkers": [
      "/auth/",
      "auth0",
      "login",
      "signin"
    ],
    "verifyUrlRegex": "^https?://(chatgpt\\.com|chat\\.openai\\.com)/",
    "prefillParam": "",
    "upload": true
  },
  {
    "id": "gemini",
    "name": "Gemini",
    "url": "https://gemini.google.com/app",
    "origins": [
      "gemini.google.com"
    ],
    "composerSelectors": [
      "rich-textarea .ql-editor",
      ".ql-editor[contenteditable=\"true\"]",
      "rich-textarea [contenteditable=\"true\"]"
    ],
    "sendSelectors": [
      "button[aria-label*=\"Send\"]",
      "button.send-button",
      "[class*=\"send-button\"]"
    ],
    "sendClassHints": [],
    "sendSvgPaths": [],
    "sendAriaLabels": [
      "Send message",
      "Send",
      "发送"
    ],
    "enterSends": false,
    "loginMarkers": [
      "accounts.google.com",
      "servicelogin",
      "signin",
      "login"
    ],
    "verifyUrlRegex": "^https?://gemini\\.google\\.com/",
    "prefillParam": "",
    "upload": true
  },
  {
    "id": "grok",
    "name": "Grok",
    "url": "https://grok.com/",
    "origins": [
      "grok.com",
      "x.com"
    ],
    "composerSelectors": [
      "textarea[aria-label]",
      "textarea"
    ],
    "sendSelectors": [
      "button[aria-label=\"Submit\"]",
      "button[type=\"submit\"]",
      "[aria-label=\"Submit\"]"
    ],
    "sendClassHints": [],
    "sendSvgPaths": [],
    "sendAriaLabels": [
      "Submit",
      "发送"
    ],
    "enterSends": false,
    "loginMarkers": [
      "login",
      "signin",
      "i/flow"
    ],
    "verifyUrlRegex": "^https?://(grok\\.com|x\\.com)/",
    "prefillParam": "",
    "upload": true
  }
]
