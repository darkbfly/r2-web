import { filesize } from 'filesize'
import * as pdfjsLib from 'pdfjs-dist'
import { AUDIO_RE, IMAGE_RE, PDF_RE, TEXT_RE, VIDEO_RE } from './constants.js'
import { t } from './i18n.js'
import { R2Client } from './r2-client.js'
import { UIManager } from './ui-manager.js'
import { $, formatDate, getErrorMessage, extractFileName, getMimeType } from './utils.js'

const PDF_MAX_SIZE = 50 * 1024 * 1024

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href

const previewFullscreenBtn = () => /** @type {HTMLElement} */ ($('#preview-fullscreen'))

class FilePreview {
  /** @type {R2Client} */
  #r2
  /** @type {UIManager} */
  #ui
  #currentKey = ''
  #currentText = ''
  #currentUrl = ''
  /** @type {import('pdfjs-dist').PDFDocumentProxy | null} */
  #pdfDoc = null
  /** @type {IntersectionObserver | null} */
  #pdfObserver = null
  /** @type {import('pdfjs-dist').RenderTask[]} */
  #pdfRenderTasks = []

  /** @param {R2Client} r2 @param {UIManager} ui */
  constructor(r2, ui) {
    this.#r2 = r2
    this.#ui = ui
    const dialog = /** @type {HTMLDialogElement} */ ($('#preview-dialog'))
    dialog.addEventListener('close', () => {
      dialog.querySelectorAll('video, audio').forEach((el) => /** @type {HTMLMediaElement} */ (el).pause())
      this.#cleanupPdf()
      dialog.classList.remove('preview-maximized')
      if (document.fullscreenElement) document.exitFullscreen()
      previewFullscreenBtn().hidden = true
    })
  }

  get currentKey() {
    return this.#currentKey
  }

  #cleanupPdf() {
    this.#pdfObserver?.disconnect()
    this.#pdfObserver = null
    for (const task of this.#pdfRenderTasks) task.cancel()
    this.#pdfRenderTasks = []
    this.#pdfDoc?.destroy()
    this.#pdfDoc = null
    $('#preview-body').classList.remove('pdf-body')
  }

  /** @param {ArrayBuffer} data */
  async #loadPdfDocument(data) {
    const pdfBytes = new Uint8Array(data)
    let password = ''
    for (;;) {
      try {
        const task = pdfjsLib.getDocument({ data: pdfBytes.slice(), password: password || undefined })
        return await task.promise
      } catch (/** @type {any} */ err) {
        if (err?.name !== 'PasswordException') throw err
        const wrong = err.code === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
        const pw = await this.#ui.prompt(t('pdfPasswordTitle'), wrong ? t('pdfPasswordWrong') : t('pdfPasswordPrompt'), '', {
          hint: t('pdfPasswordHint'),
          inputType: 'password',
        })
        if (!pw) throw new Error(t('pdfPasswordCancelled'))
        password = pw
      }
    }
  }

  /**
   * @param {string} key
   * @param {HTMLElement} body
   * @param {HTMLElement} copyBtn
   */
  async #renderPdf(key, body, copyBtn) {
    const res = await this.#r2.getObject(key)
    const buf = await res.arrayBuffer()
    if (buf.byteLength > PDF_MAX_SIZE) {
      body.innerHTML = `<p style="color:var(--text-tertiary)">${t('pdfTooLarge')}</p>`
      return
    }

    const pdf = await this.#loadPdfDocument(buf)
    this.#pdfDoc = pdf

    body.innerHTML = ''
    body.classList.add('pdf-body')
    const viewer = document.createElement('div')
    viewer.className = 'pdf-viewer'

    /** @type {{ pageEl: HTMLElement, canvas: HTMLCanvasElement, pageNum: number, rendered: boolean }[]} */
    const pages = []
    for (let i = 1; i <= pdf.numPages; i++) {
      const pageEl = document.createElement('div')
      pageEl.className = 'pdf-page'
      const canvas = document.createElement('canvas')
      pageEl.appendChild(canvas)
      viewer.appendChild(pageEl)
      pages.push({ pageEl, canvas, pageNum: i, rendered: false })
    }
    body.appendChild(viewer)

    const url = this.#r2.getPublicUrl(key) ?? (await this.#r2.getPresignedUrl(key))
    this.#currentUrl = url
    copyBtn.dataset.tooltip = t('copyLink')
    copyBtn.hidden = false
    previewFullscreenBtn().hidden = false

    /** @param {{ pageEl: HTMLElement, canvas: HTMLCanvasElement, pageNum: number, rendered: boolean }} entry */
    const renderPage = async (entry) => {
      if (entry.rendered || !this.#pdfDoc) return
      entry.rendered = true
      const page = await this.#pdfDoc.getPage(entry.pageNum)
      const containerWidth = viewer.clientWidth || body.clientWidth || 800
      const baseViewport = page.getViewport({ scale: 1 })
      const scale = containerWidth / baseViewport.width
      const viewport = page.getViewport({ scale })
      const canvas = entry.canvas
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      canvas.width = viewport.width
      canvas.height = viewport.height
      const renderTask = page.render({ canvasContext: ctx, viewport })
      this.#pdfRenderTasks.push(renderTask)
      await renderTask.promise
    }

    /** @param {{ pageEl: HTMLElement, canvas: HTMLCanvasElement, pageNum: number, rendered: boolean }} entry */
    const releasePage = (entry) => {
      if (!entry.rendered) return
      entry.rendered = false
      entry.canvas.width = 0
      entry.canvas.height = 0
    }

    this.#pdfObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const idx = pages.findIndex((p) => p.pageEl === e.target)
          if (idx === -1) continue
          if (e.isIntersecting) {
            renderPage(pages[idx]).catch(() => {})
            if (idx > 0) renderPage(pages[idx - 1]).catch(() => {})
            if (idx < pages.length - 1) renderPage(pages[idx + 1]).catch(() => {})
          } else {
            releasePage(pages[idx])
          }
        }
      },
      { root: viewer, rootMargin: '200px' },
    )
    pages.forEach((p) => this.#pdfObserver?.observe(p.pageEl))
  }

  /** @param {{key: string, size?: number, lastModified?: number}} item */
  async preview(item) {
    const key = item.key
    this.#currentKey = key
    this.#currentText = ''
    this.#currentUrl = ''
    this.#cleanupPdf()
    const dialog = /** @type {HTMLDialogElement} */ ($('#preview-dialog'))
    dialog.classList.remove('preview-maximized')
    previewFullscreenBtn().hidden = true
    const body = $('#preview-body')
    const footer = $('#preview-footer')
    const filename = $('#preview-filename')
    const copyBtn = /** @type {HTMLElement} */ ($('#preview-copy'))
    const copyTextBtn = /** @type {HTMLElement} */ ($('#preview-copy-text'))
    const copyImageBtn = /** @type {HTMLElement} */ ($('#preview-copy-image'))

    filename.textContent = extractFileName(key)
    body.innerHTML = '<div style="color:var(--text-tertiary)">Loading...</div>'
    footer.innerHTML = ''
    footer.classList.remove('bordered')
    copyBtn.hidden = true
    copyTextBtn.hidden = true
    copyImageBtn.hidden = true
    dialog.showModal()

    try {
      let realContentType = getMimeType(key)
      try {
        const head = await this.#r2.headObject(key)
        if (head.contentType) realContentType = head.contentType
      } catch {}

      const meta = {
        contentLength: item.size ?? 0,
        contentType: realContentType,
        lastModified: item.lastModified ? new Date(item.lastModified) : undefined,
      }

      footer.classList.add('bordered')
      footer.innerHTML = `
        <span>${t('size')}: ${filesize(meta.contentLength)}</span>
        <span>${t('contentType')}: ${meta.contentType || 'unknown'}</span>
        ${meta.lastModified ? `<span>${t('lastModified')}: ${formatDate(meta.lastModified)}</span>` : ''}
      `

      if (IMAGE_RE.test(key)) {
        const url = this.#r2.getPublicUrl(key) ?? (await this.#r2.getPresignedUrl(key))
        this.#currentUrl = url
        body.innerHTML = ''
        const img = document.createElement('img')
        img.src = url
        img.alt = extractFileName(key)
        body.appendChild(img)
        copyImageBtn.dataset.tooltip = t('copyImage')
        copyImageBtn.hidden = false
        copyBtn.dataset.tooltip = t('copyLink')
        copyBtn.hidden = false
      } else if (VIDEO_RE.test(key)) {
        const url = this.#r2.getPublicUrl(key) ?? (await this.#r2.getPresignedUrl(key))
        this.#currentUrl = url
        body.innerHTML = ''
        const video = document.createElement('video')
        video.src = url
        video.controls = true
        body.appendChild(video)
        copyBtn.dataset.tooltip = t('copyLink')
        copyBtn.hidden = false
      } else if (AUDIO_RE.test(key)) {
        const url = this.#r2.getPublicUrl(key) ?? (await this.#r2.getPresignedUrl(key))
        this.#currentUrl = url
        body.innerHTML = ''
        const audio = document.createElement('audio')
        audio.src = url
        audio.controls = true
        body.appendChild(audio)
        copyBtn.dataset.tooltip = t('copyLink')
        copyBtn.hidden = false
      } else if (TEXT_RE.test(key)) {
        const url = this.#r2.getPublicUrl(key) ?? (await this.#r2.getPresignedUrl(key))
        this.#currentUrl = url
        const res = await this.#r2.getObject(key)
        const text = await res.text()
        this.#currentText = text
        body.innerHTML = ''
        const pre = document.createElement('pre')
        pre.textContent = text
        body.appendChild(pre)
        copyBtn.dataset.tooltip = t('copyLink')
        copyBtn.hidden = false
        copyTextBtn.dataset.tooltip = t('copyText')
        copyTextBtn.hidden = false
      } else if (PDF_RE.test(key) || realContentType === 'application/pdf') {
        await this.#renderPdf(key, body, copyBtn)
      } else {
        body.innerHTML = `<p style="color:var(--text-tertiary)">${t('previewNotAvailable')}</p>`
      }
    } catch (/** @type {any} */ err) {
      this.#cleanupPdf()
      previewFullscreenBtn().hidden = true
      const errP = document.createElement('p')
      errP.style.color = 'var(--text-danger)'
      errP.textContent = err.message || t('pdfLoadFailed')
      body.innerHTML = ''
      body.appendChild(errP)
    }
  }

  async downloadCurrent() {
    if (!this.#currentKey) return
    try {
      const filename = extractFileName(this.#currentKey)
      const url = await this.#r2.getDownloadUrl(this.#currentKey, filename)
      const a = document.createElement('a')
      a.href = url
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (/** @type {any} */ err) {
      const errorKey = getErrorMessage(err)
      if (errorKey === 'networkError') {
        this.#ui.toast(t('networkError', { msg: err.message }), 'error')
      } else {
        this.#ui.toast(t(/** @type {any} */ (errorKey)), 'error')
      }
    }
  }

  async copyCurrentLink() {
    if (!this.#currentUrl) return
    try {
      await navigator.clipboard.writeText(this.#currentUrl)
      this.#ui.toast(t('linkCopied'), 'success')
    } catch {
      await this.#ui.prompt(t('copyLink'), t('copyUrl'), this.#currentUrl)
    }
  }

  async copyCurrentImage() {
    if (!this.#currentUrl) return
    if (!navigator.clipboard?.write) {
      this.#ui.toast(t('copyImageNotSupported'), 'error')
      return
    }
    try {
      const res = await fetch(this.#currentUrl)
      const blob = await res.blob()
      const pngBlob = await new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          const canvas = document.createElement('canvas')
          canvas.width = img.naturalWidth
          canvas.height = img.naturalHeight
          canvas.getContext('2d').drawImage(img, 0, 0)
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error())), 'image/png')
          URL.revokeObjectURL(img.src)
        }
        img.onerror = reject
        img.src = URL.createObjectURL(blob)
      })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
      this.#ui.toast(t('copyImageSuccess'), 'success')
    } catch {
      this.#ui.toast(t('copyImageFailed'), 'error')
    }
  }

  async copyCurrentText() {
    if (!this.#currentText) return
    try {
      await navigator.clipboard.writeText(this.#currentText)
      this.#ui.toast(t('copyTextSuccess'), 'success')
    } catch {
      await this.#ui.prompt(t('copyTextTitle'), t('copyTextLabel'), this.#currentText)
    }
  }
}

export { FilePreview }
