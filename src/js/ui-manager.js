import QRCode from 'qrcode'
import { IMAGE_RE, VIDEO_RE, AUDIO_RE, TOAST_DURATION, THEME_KEY } from './constants.js'
import { t } from './i18n.js'
import { $, extractFileName } from './utils.js'

class UIManager {
  initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || 'auto'

    if (saved === 'auto') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light')
    } else {
      document.documentElement.setAttribute('data-theme', saved)
    }

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (localStorage.getItem(THEME_KEY) === 'auto') {
        const apply = () => {
          document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light')
        }
        if (document.startViewTransition) {
          document.startViewTransition(apply)
        } else {
          apply()
        }
      }
    })
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme')
    const next = current === 'dark' ? 'light' : 'dark'
    const apply = () => {
      document.documentElement.setAttribute('data-theme', next)
      localStorage.setItem(THEME_KEY, next)
    }
    if (document.startViewTransition) {
      document.startViewTransition(apply)
    } else {
      apply()
    }
  }

  /** @param {string} theme - 'light' | 'dark' | 'auto' */
  setTheme(theme) {
    let effectiveTheme = theme

    if (theme === 'auto') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      effectiveTheme = prefersDark ? 'dark' : 'light'
      localStorage.setItem(THEME_KEY, 'auto')
    } else {
      localStorage.setItem(THEME_KEY, theme)
    }

    const apply = () => {
      document.documentElement.setAttribute('data-theme', effectiveTheme)
    }

    if (document.startViewTransition) {
      document.startViewTransition(apply)
    } else {
      apply()
    }
  }

  /** @param {string} message @param {'info' | 'success' | 'error'} [type] */
  toast(message, type = 'info') {
    const icons = {
      success:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
      error:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    }

    const openDialog = /** @type {HTMLDialogElement | null} */ (document.querySelector('dialog[open]'))

    let container
    if (openDialog) {
      container = openDialog.querySelector('.toast-container-dialog')
      if (!container) {
        container = document.createElement('div')
        container.className = 'toast-container-dialog'
        container.style.cssText =
          'position:fixed;bottom:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:2147483647;pointer-events:none;'
        openDialog.appendChild(container)
      }
    } else {
      container = $('#toast-container')
    }

    const el = document.createElement('div')
    el.className = `toast ${type}`
    const iconSpan = document.createElement('span')
    iconSpan.className = 'toast-icon'
    iconSpan.innerHTML = icons[type]
    const msgSpan = document.createElement('span')
    msgSpan.textContent = message
    el.appendChild(iconSpan)
    el.appendChild(msgSpan)

    container.appendChild(el)
    const duration = message.length > 80 ? TOAST_DURATION * 2 : TOAST_DURATION
    setTimeout(() => {
      el.classList.add('removing')
      el.addEventListener('animationend', () => {
        el.remove()
        if (container.classList.contains('toast-container-dialog') && !container.children.length) {
          container.remove()
        }
      })
    }, duration)
  }

  showSkeleton() {
    const skeletonGrid = $('#skeleton-grid')
    const browser = $('#file-browser')
    const view = browser.dataset.view
    const density = browser.dataset.density
    const isMobile = window.innerWidth <= 640

    let count
    if (view === 'list' || isMobile) {
      count = density === 'compact' ? 8 : density === 'loose' ? 5 : 6
    } else {
      const gridMin = density === 'compact' ? 120 : density === 'loose' ? 200 : 160
      const availableWidth = Math.max(window.innerWidth - 320, 600)
      const cols = Math.floor(availableWidth / (gridMin + 16))
      const rows = density === 'compact' ? 2 : 1.5
      count = Math.ceil(cols * rows)
    }

    skeletonGrid.innerHTML = Array(count).fill('<div class="skeleton-card"></div>').join('')
    skeletonGrid.hidden = false
    $('#file-grid').hidden = true
    $('#empty-state').hidden = true
  }

  hideSkeleton() {
    $('#skeleton-grid').hidden = true
    $('#file-grid').hidden = false
  }

  showEmptyState() {
    $('#empty-state').hidden = false
    $('#file-grid').hidden = true
  }

  hideEmptyState() {
    $('#empty-state').hidden = true
  }

  /** @param {number} x @param {number} y @param {string} key @param {boolean} isFolder @param {{size?: number, mod?: number}} [meta] */
  showContextMenu(x, y, key, isFolder, meta = {}) {
    const menu = $('#context-menu')
    menu.dataset.key = key
    menu.dataset.isFolder = String(isFolder)
    if (meta.size !== undefined) menu.dataset.size = String(meta.size)
    if (meta.mod !== undefined) menu.dataset.mod = String(meta.mod)

    const previewBtn = $('[data-action="preview"]', menu)
    const downloadBtn = $('[data-action="download"]', menu)
    const shareQrBtn = $('#ctx-share-qr', menu)
    const copyLinkBtn = $('#ctx-copy-link', menu)
    const copyMarkdownBtn = $('#ctx-copy-markdown', menu)
    const copyHtmlBtn = $('#ctx-copy-html', menu)
    const copyImageBtn = $('#ctx-copy-image', menu)
    const copyImageSep = $('#ctx-sep-copy-image', menu)
    const fileSep = $('#ctx-sep-file', menu)
    const editContentTypeBtn = /** @type {HTMLElement} */ ($('#ctx-edit-content-type', menu))
    previewBtn.hidden = isFolder
    downloadBtn.hidden = isFolder
    shareQrBtn.hidden = isFolder
    copyLinkBtn.hidden = isFolder
    const isImage = !isFolder && IMAGE_RE.test(key)
    const isVideo = !isFolder && VIDEO_RE.test(key)
    const isAudio = !isFolder && AUDIO_RE.test(key)
    copyMarkdownBtn.hidden = !isImage
    copyHtmlBtn.hidden = !(isImage || isVideo || isAudio)
    copyImageBtn.hidden = !isImage
    copyImageSep.hidden = !isImage
    editContentTypeBtn.hidden = isFolder
    fileSep.hidden = isFolder

    menu.style.left = x + 'px'
    menu.style.top = y + 'px'
    menu.showPopover()

    const rect = menu.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (rect.right > vw) menu.style.left = vw - rect.width - 8 + 'px'
    if (rect.bottom > vh) menu.style.top = vh - rect.height - 8 + 'px'

    const submenu = $('.context-submenu', menu)
    if (submenu) {
      submenu.classList.toggle('flip-left', rect.right + 160 > vw)
    }
  }

  /** @param {boolean} [instant=false] Skip animation for instant close */
  hideContextMenu(instant = false) {
    const menu = $('#context-menu')
    try {
      if (instant) {
        menu.classList.add('instant')
        menu.offsetHeight
      }
      menu.hidePopover()
      if (instant) {
        setTimeout(() => menu.classList.remove('instant'), 0)
      }
    } catch {
      /* already hidden */
    }
  }

  /**
   * @param {string} title
   * @param {string} label
   * @param {string} [defaultValue]
   * @param {{ validate?: (v: string) => string | null, hint?: string, preview?: (v: string) => string, inputType?: string }} [options]
   * @returns {Promise<string | null>}
   */
  prompt(title, label, defaultValue = '', { validate, hint, preview, inputType = 'text' } = {}) {
    return new Promise((resolve) => {
      const dialog = /** @type {HTMLDialogElement} */ ($('#prompt-dialog'))
      const form = $('#prompt-form')
      const input = /** @type {HTMLInputElement} */ ($('#prompt-input'))
      const errorEl = $('#prompt-error')
      const hintEl = $('#prompt-hint')
      const previewEl = $('#prompt-preview')
      $('#prompt-title').textContent = title
      $('#prompt-label').textContent = label
      input.value = defaultValue
      input.type = inputType
      errorEl.textContent = ''
      errorEl.hidden = true
      hintEl.textContent = hint ?? ''
      hintEl.hidden = !hint

      const updatePreview = () => {
        if (!preview) {
          previewEl.hidden = true
          return
        }
        previewEl.textContent = preview(input.value)
        previewEl.hidden = false
      }
      updatePreview()

      /** @type {string | null} */
      let result = null

      /** @returns {boolean} */
      const checkValid = () => {
        if (!validate) return true
        const err = validate(input.value)
        errorEl.textContent = err ?? ''
        errorEl.hidden = !err
        return !err
      }

      const onInput = () => {
        checkValid()
        updatePreview()
      }

      /** @param {Event} e */
      const onSubmit = (e) => {
        e.preventDefault()
        if (!checkValid()) {
          input.focus()
          return
        }
        result = input.value.trim() || null
        dialog.close()
      }

      const onCancel = () => dialog.close()

      /** @param {Event} e */
      const onBackdropClick = (e) => {
        if (e.target === dialog) dialog.close()
      }

      const onClose = () => {
        form.removeEventListener('submit', onSubmit)
        input.removeEventListener('input', onInput)
        $('#prompt-cancel').removeEventListener('click', onCancel)
        dialog.removeEventListener('click', onBackdropClick)
        previewEl.hidden = true
        input.type = 'text'
        resolve(result)
      }

      form.addEventListener('submit', onSubmit)
      input.addEventListener('input', onInput)
      $('#prompt-cancel').addEventListener('click', onCancel)
      dialog.addEventListener('click', onBackdropClick)
      dialog.addEventListener('close', onClose, { once: true })
      dialog.showModal()
      input.focus()
      input.select()
    })
  }

  dismissPrompt() {
    const dialog = /** @type {HTMLDialogElement} */ ($('#prompt-dialog'))
    if (dialog.open) dialog.close()
  }

  /** @param {string} title @param {string} message @returns {Promise<boolean>} */
  confirm(title, message) {
    return new Promise((resolve) => {
      const dialog = /** @type {HTMLDialogElement} */ ($('#confirm-dialog'))
      const form = $('#confirm-form')
      $('#confirm-title').textContent = title
      $('#confirm-message').textContent = message

      let result = false

      /** @param {Event} e */
      const onSubmit = (e) => {
        e.preventDefault()
        result = true
        dialog.close()
      }

      const onCancel = () => dialog.close()

      /** @param {Event} e */
      const onBackdropClick = (e) => {
        if (e.target === dialog) dialog.close()
      }

      const onClose = () => {
        form.removeEventListener('submit', onSubmit)
        $('#confirm-cancel').removeEventListener('click', onCancel)
        dialog.removeEventListener('click', onBackdropClick)
        resolve(result)
      }

      form.addEventListener('submit', onSubmit)
      $('#confirm-cancel').addEventListener('click', onCancel)
      dialog.addEventListener('click', onBackdropClick)
      dialog.addEventListener('close', onClose, { once: true })
      dialog.showModal()
    })
  }

  /**
   * Show overwrite confirmation dialog when a file already exists.
   * @param {string} name - Filename to display
   * @param {boolean} [showApplyAll] - Whether to show "Apply to all" buttons (batch upload)
   * @returns {Promise<'overwrite' | 'skip' | 'overwrite-all' | 'skip-all'>}
   */
  confirmOverwrite(name, showApplyAll = false) {
    return new Promise((resolve) => {
      const dialog = /** @type {HTMLDialogElement} */ ($('#overwrite-dialog'))
      $('#overwrite-title').textContent = t('overwriteTitle')
      $('#overwrite-message').textContent = t('overwriteMsg', { name })
      $('#overwrite-skip').textContent = t('overwriteSkip')
      $('#overwrite-skip-all').textContent = t('overwriteSkipAll')
      $('#overwrite-ok').textContent = t('overwriteConfirm')
      $('#overwrite-ok-all').textContent = t('overwriteAll')
      $('#overwrite-skip-all').hidden = !showApplyAll
      $('#overwrite-ok-all').hidden = !showApplyAll

      /** @type {'overwrite' | 'skip' | 'overwrite-all' | 'skip-all'} */
      let result = 'skip'

      const onSkip = () => {
        result = 'skip'
        dialog.close()
      }
      const onSkipAll = () => {
        result = 'skip-all'
        dialog.close()
      }
      const onOverwrite = () => {
        result = 'overwrite'
        dialog.close()
      }
      const onOverwriteAll = () => {
        result = 'overwrite-all'
        dialog.close()
      }

      /** @param {Event} e */
      const onBackdropClick = (e) => {
        if (e.target === dialog) dialog.close()
      }

      const onClose = () => {
        $('#overwrite-skip').removeEventListener('click', onSkip)
        $('#overwrite-skip-all').removeEventListener('click', onSkipAll)
        $('#overwrite-ok').removeEventListener('click', onOverwrite)
        $('#overwrite-ok-all').removeEventListener('click', onOverwriteAll)
        dialog.removeEventListener('click', onBackdropClick)
        resolve(result)
      }

      $('#overwrite-skip').addEventListener('click', onSkip)
      $('#overwrite-skip-all').addEventListener('click', onSkipAll)
      $('#overwrite-ok').addEventListener('click', onOverwrite)
      $('#overwrite-ok-all').addEventListener('click', onOverwriteAll)
      dialog.addEventListener('click', onBackdropClick)
      dialog.addEventListener('close', onClose, { once: true })
      dialog.showModal()
    })
  }

  /** @param {string} shareUrl */
  async showShareDialog(shareUrl) {
    const dialog = /** @type {HTMLDialogElement} */ ($('#share-dialog'))
    const urlInput = /** @type {HTMLInputElement} */ ($('#share-url-input'))
    const qrCanvas = /** @type {HTMLCanvasElement} */ ($('#share-qr-canvas'))

    urlInput.value = shareUrl

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark'

    try {
      await QRCode.toCanvas(qrCanvas, shareUrl, {
        width: 168,
        margin: 0,
        color: {
          dark: isDark ? '#FFFFFF' : '#000000',
          light: isDark ? '#0a0a0a' : '#ffffff',
        },
        errorCorrectionLevel: 'M',
      })
    } catch (err) {
      console.error('Failed to generate QR code:', err)
    }

    const onCopy = async () => {
      try {
        await navigator.clipboard.writeText(shareUrl)
        this.toast(t('shareConfigCopied'), 'success')
      } catch {
        urlInput.select()
      }
    }

    const onClose = () => dialog.close()

    /** @param {Event} e */
    const onBackdropClick = (e) => {
      if (e.target === dialog) dialog.close()
    }

    const onDialogClose = () => {
      $('#copy-share-url-btn').removeEventListener('click', onCopy)
      $('#share-dialog-close').removeEventListener('click', onClose)
      dialog.removeEventListener('click', onBackdropClick)
    }

    $('#copy-share-url-btn').addEventListener('click', onCopy)
    $('#share-dialog-close').addEventListener('click', onClose)
    dialog.addEventListener('click', onBackdropClick)
    dialog.addEventListener('close', onDialogClose, { once: true })

    dialog.showModal()
  }

  /** @param {string} fileUrl @param {string} fileName */
  async showFileQrDialog(fileUrl, fileName) {
    const dialog = /** @type {HTMLDialogElement} */ ($('#file-qr-dialog'))
    const urlInput = /** @type {HTMLInputElement} */ ($('#file-qr-url'))
    const qrCanvas = /** @type {HTMLCanvasElement} */ ($('#file-qr-canvas'))
    const nameEl = $('#file-qr-filename')
    const copyBtn = $('#file-qr-copy')

    urlInput.value = fileUrl
    nameEl.textContent = fileName

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark'

    try {
      await QRCode.toCanvas(qrCanvas, fileUrl, {
        width: 168,
        margin: 0,
        color: {
          dark: isDark ? '#FFFFFF' : '#000000',
          light: isDark ? '#0a0a0a' : '#ffffff',
        },
        errorCorrectionLevel: 'M',
      })
    } catch (err) {
      console.error('Failed to generate QR code:', err)
    }

    const onCopy = async () => {
      try {
        await navigator.clipboard.writeText(fileUrl)
        this.toast(t('linkCopied'), 'success')
      } catch {
        urlInput.select()
      }
    }

    const onClose = () => dialog.close()

    /** @param {Event} e */
    const onBackdropClick = (e) => {
      if (e.target === dialog) dialog.close()
    }

    const onDialogClose = () => {
      $('#file-qr-close').removeEventListener('click', onClose)
      copyBtn.removeEventListener('click', onCopy)
      dialog.removeEventListener('click', onBackdropClick)
    }

    copyBtn.addEventListener('click', onCopy)
    $('#file-qr-close').addEventListener('click', onClose)
    dialog.addEventListener('click', onBackdropClick)
    dialog.addEventListener('close', onDialogClose, { once: true })

    dialog.showModal()
  }

  /**
   * Choose how to apply a template path when current directory isn't root.
   * @param {string} currentPrefix
   * @param {string} processedName
   * @param {string} template
   * @returns {Promise<'template'|'prefix-template'|'prefix-basename'|null>}
   */
  chooseFilenameTemplatePath(currentPrefix, processedName, template) {
    return new Promise((resolve) => {
      const dialog = /** @type {HTMLDialogElement} */ ($('#filename-path-dialog'))
      const form = $('#filename-path-form')
      const optionTemplate = $('#filename-path-option-template')
      const optionPrefixTemplate = $('#filename-path-option-prefix-template')
      const optionPrefixBasename = $('#filename-path-option-prefix-basename')
      const choicePrefixTemplate = /** @type {HTMLInputElement} */ ($('#filename-path-choice-prefix-template'))

      /** @param {string} str */
      const trimSlashes = (str) => str.replace(/^\/+|\/+$/g, '')
      const prefixClean = trimSlashes(currentPrefix)
      const nameClean = processedName.replace(/^\/+/, '')
      const baseName = extractFileName(processedName).replace(/^\/+/, '')
      const prefixLabel = prefixClean ? `/${prefixClean}` : '/'

      const templatePath = '/' + nameClean
      const prefixTemplatePath = prefixClean ? `/${prefixClean}/${nameClean}` : `/${nameClean}`
      const prefixBasenamePath = prefixClean ? `/${prefixClean}/${baseName}` : `/${baseName}`

      $('#filename-path-title').textContent = t('filenameTplPathTitle')
      $('#filename-path-desc').textContent = t('filenameTplPathDescWithTpl', {
        prefix: prefixLabel,
        template: template || '-',
      })
      optionTemplate.textContent = templatePath
      optionPrefixTemplate.textContent = prefixTemplatePath
      optionPrefixBasename.textContent = prefixBasenamePath

      // Default choice: current directory + template path
      choicePrefixTemplate.checked = true

      /** @type {'template'|'prefix-template'|'prefix-basename'|null} */
      let result = null

      /** @param {Event} e */
      const onSubmit = (e) => {
        e.preventDefault()
        const selected = dialog.querySelector('input[name=\"filenamePathChoice\"]:checked')
        result = /** @type {any} */ (selected)?.value || 'prefix-template'
        dialog.close()
      }

      const onCancel = () => dialog.close()

      /** @param {Event} e */
      const onBackdropClick = (e) => {
        if (e.target === dialog) dialog.close()
      }

      const onClose = () => {
        form.removeEventListener('submit', onSubmit)
        $('#filename-path-cancel').removeEventListener('click', onCancel)
        dialog.removeEventListener('click', onBackdropClick)
        resolve(result)
      }

      form.addEventListener('submit', onSubmit)
      $('#filename-path-cancel').addEventListener('click', onCancel)
      dialog.addEventListener('click', onBackdropClick)
      dialog.addEventListener('close', onClose, { once: true })
      dialog.showModal()
    })
  }

  initTooltip() {
    if (this.tooltipInitialized) return
    this.tooltipInitialized = true

    const tip = /** @type {HTMLElement} */ ($('#tooltip'))
    /** @type {number | null} */
    let showTimer = null
    /** @type {HTMLElement | null} */
    let currentTarget = null

    const show = (/** @type {HTMLElement} */ target) => {
      const text = target.dataset.tooltip
      if (!text) return
      tip.textContent = text

      const parentDialog = target.closest('dialog[open]')
      if (parentDialog && tip.parentElement !== parentDialog) {
        parentDialog.appendChild(tip)
      } else if (!parentDialog && tip.parentElement !== document.body) {
        document.body.appendChild(tip)
      }

      tip.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:1;z-index:2147483647'
      const tipRect = tip.getBoundingClientRect()

      const rect = target.getBoundingClientRect()
      const GAP = 8

      let top = rect.bottom + GAP
      let left = rect.left + rect.width / 2

      if (top + tipRect.height > window.innerHeight) {
        top = rect.top - GAP - tipRect.height
      }

      left = Math.max(GAP, Math.min(left - tipRect.width / 2, window.innerWidth - tipRect.width - GAP))

      tip.style.cssText = `position:fixed;left:${left}px;top:${top}px;z-index:2147483647;pointer-events:none`
      tip.offsetHeight
      tip.classList.add('visible')
    }

    const hide = () => {
      if (showTimer) {
        clearTimeout(showTimer)
        showTimer = null
      }
      currentTarget = null
      tip.classList.remove('visible')

      if (tip.parentElement !== document.body) {
        document.body.appendChild(tip)
      }
    }

    document.addEventListener('mouseover', (e) => {
      const eventTarget = e.target
      const target = /** @type {HTMLElement | null} */ (
        eventTarget instanceof Element ? eventTarget.closest('[data-tooltip]') : null
      )

      if (target) {
        if (target !== currentTarget) {
          if (showTimer) clearTimeout(showTimer)
          currentTarget = target
          const delay = tip.classList.contains('visible') ? 0 : 100
          showTimer = /** @type {any} */ (setTimeout(() => show(target), delay))
        }
      } else if (currentTarget) {
        hide()
      }
    })

    document.addEventListener('mouseout', (e) => {
      const eventTarget = e.target
      const target = /** @type {HTMLElement | null} */ (
        eventTarget instanceof Element ? eventTarget.closest('[data-tooltip]') : null
      )

      if (target === currentTarget && target) {
        const relatedTarget = e.relatedTarget

        const movingToTooltip = relatedTarget instanceof Element && relatedTarget.closest('[data-tooltip]')

        const stillInside = relatedTarget instanceof Node && target.contains(relatedTarget)

        if (!movingToTooltip && !stillInside) {
          hide()
        }
      }
    })

    document.addEventListener('pointerdown', hide)
    document.addEventListener('scroll', hide, true)
  }
}

export { UIManager }
