import { filesize } from 'filesize'
import * as pdfjsLib from 'pdfjs-dist'
import { AUDIO_RE, IMAGE_RE, PDF_RE, TEXT_RE, VIDEO_RE } from './constants.js'
import { t } from './i18n.js'
import { R2Client } from './r2-client.js'
import { UIManager } from './ui-manager.js'
import { $, formatDate, getErrorMessage, extractFileName, getBaseName, getMimeType } from './utils.js'

const PDF_MAX_SIZE = 50 * 1024 * 1024
const PDF_DL_WEIGHT = 0.9
const PDF_PARSE_WEIGHT = 0.1

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
  #previewGen = 0
  /** @type {import('pdfjs-dist').PDFDocumentProxy | null} */
  #pdfDoc = null
  /** @type {import('pdfjs-dist').RenderTask[]} */
  #pdfRenderTasks = []
  /** @type {AbortController | null} */
  #loadAbort = null
  /** @type {ReadableStreamDefaultReader<Uint8Array> | null} */
  #bodyReader = null
  /** @type {import('pdfjs-dist').PDFDocumentLoadingTask | null} */
  #pdfLoadingTask = null

  #abortLoad() {
    this.#ui.dismissPrompt()
    this.#loadAbort?.abort()
    this.#loadAbort = null
    this.#bodyReader?.cancel().catch(() => {})
    this.#bodyReader = null
    this.#pdfLoadingTask?.destroy()
    this.#pdfLoadingTask = null
  }

  /** @param {number} gen */
  #isStale(gen) {
    return gen !== this.#previewGen
  }

  /** @param {number} gen @param {HTMLElement} body */
  #canTouchDom(gen, body) {
    const dialog = /** @type {HTMLDialogElement} */ ($('#preview-dialog'))
    return !this.#isStale(gen) && dialog.open && body.isConnected
  }

  /** @param {R2Client} r2 @param {UIManager} ui */
  constructor(r2, ui) {
    this.#r2 = r2
    this.#ui = ui
    const dialog = /** @type {HTMLDialogElement} */ ($('#preview-dialog'))
    dialog.addEventListener('close', () => {
      dialog.querySelectorAll('video, audio').forEach((el) => /** @type {HTMLMediaElement} */ (el).pause())
      this.#previewGen++
      this.#abortLoad()
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
    for (const task of this.#pdfRenderTasks) task.cancel()
    this.#pdfRenderTasks = []
    this.#pdfDoc?.destroy()
    this.#pdfDoc = null
    $('#preview-body').classList.remove('pdf-body')
  }

  /**
   * @param {HTMLElement} body
   * @param {number} gen
   * @param {{ pct: number, label: string, loaded?: number, total?: number, indeterminate?: boolean }} opts
   */
  #setPdfProgress(body, gen, { pct, label, loaded = 0, total = 0, indeterminate = false }) {
    if (!this.#canTouchDom(gen, body)) return
    let wrap = body.querySelector('.pdf-load-progress')
    if (!wrap) {
      body.innerHTML = `
        <div class="pdf-load-progress">
          <p class="pdf-load-status"></p>
          <div class="upload-progress"><div class="upload-progress-bar"></div></div>
          <p class="pdf-load-percent"></p>
        </div>`
      wrap = body.querySelector('.pdf-load-progress')
    }
    const bar = /** @type {HTMLElement} */ (wrap.querySelector('.upload-progress-bar'))
    const status = /** @type {HTMLElement} */ (wrap.querySelector('.pdf-load-status'))
    const pctEl = /** @type {HTMLElement} */ (wrap.querySelector('.pdf-load-percent'))
    status.textContent = label
    const knownTotal = total > 0
    if (indeterminate || !knownTotal) {
      bar.classList.add('indeterminate')
      bar.style.width = ''
      pctEl.textContent = loaded > 0 ? filesize(loaded) : '…'
      return
    }
    bar.classList.remove('indeterminate')
    bar.style.width = `${Math.min(100, Math.max(0, pct))}%`
    const bytePct = Math.min(100, Math.round((loaded / total) * 100))
    pctEl.textContent = t('pdfLoadingSize', {
      loaded: filesize(loaded),
      total: filesize(total),
      pct: bytePct,
    })
  }

  /**
   * @param {Response} res
   * @param {number} total
   * @param {(loaded: number, total: number) => void} onProgress
   * @param {AbortSignal} [signal]
   */
  async #readResponseWithProgress(res, total, onProgress, signal) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (!res.body) {
      const buf = await res.arrayBuffer()
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const size = buf.byteLength
      onProgress(size, size || total)
      return buf
    }
    const reader = res.body.getReader()
    this.#bodyReader = reader
    const chunks = []
    let loaded = 0
    try {
      while (true) {
        if (signal?.aborted) {
          await reader.cancel()
          throw new DOMException('Aborted', 'AbortError')
        }
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        loaded += value.length
        onProgress(loaded, total)
      }
    } finally {
      if (this.#bodyReader === reader) this.#bodyReader = null
    }
    const out = new Uint8Array(loaded)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    onProgress(loaded, total > 0 ? total : loaded)
    return out.buffer
  }

  /**
   * @param {ArrayBuffer} data
   * @param {number} gen
   * @param {(loaded: number, total: number) => void} [onParseProgress]
   * @param {AbortSignal} [signal]
   * @param {string} [defaultPassword]
   */
  async #loadPdfDocument(data, gen, onParseProgress, signal, defaultPassword = '') {
    const pdfBytes = new Uint8Array(data)
    let password = defaultPassword
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        const task = pdfjsLib.getDocument({ data: pdfBytes.slice(), password: password || undefined })
        this.#pdfLoadingTask = task
        if (onParseProgress) {
          task.onProgress = (p) => {
            onParseProgress(p.loaded, p.total)
          }
        }
        const doc = await task.promise
        if (this.#pdfLoadingTask === task) this.#pdfLoadingTask = null
        return doc
      } catch (/** @type {any} */ err) {
        this.#pdfLoadingTask?.destroy()
        this.#pdfLoadingTask = null
        if (err?.name === 'AbortError' || signal?.aborted) throw err
        if (err?.name !== 'PasswordException') throw err
        const wrong = err.code === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
        const pw = await this.#ui.prompt(t('pdfPasswordTitle'), wrong ? t('pdfPasswordWrong') : t('pdfPasswordPrompt'), wrong ? '' : defaultPassword, {
          hint: t('pdfPasswordHint'),
          inputType: 'password',
        })
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        if (!pw) throw new Error(t('pdfPasswordCancelled'))
        password = pw
      }
    }
  }

  /**
   * @param {string} key
   * @param {HTMLElement} body
   * @param {HTMLElement} copyBtn
   * @param {number} gen
   * @param {number} [fileSize]
   */
  async #renderPdf(key, body, copyBtn, gen, fileSize = 0) {
    const signal = this.#loadAbort?.signal
    this.#setPdfProgress(body, gen, {
      label: t('pdfLoadingDownload'),
      loaded: 0,
      total: fileSize,
      pct: 0,
      indeterminate: fileSize <= 0,
    })

    const res = await this.#r2.getObject(key, signal)
    if (this.#isStale(gen)) return
    const total = Number(res.headers.get('content-length')) || fileSize || 0

    const buf = await this.#readResponseWithProgress(
      res,
      total,
      (loaded, knownTotal) => {
        const effectiveTotal = knownTotal > 0 ? knownTotal : total
        const ratio = effectiveTotal > 0 ? loaded / effectiveTotal : 0
        this.#setPdfProgress(body, gen, {
          label: t('pdfLoadingDownload'),
          loaded,
          total: effectiveTotal,
          pct: ratio * PDF_DL_WEIGHT * 100,
          indeterminate: effectiveTotal <= 0,
        })
      },
      signal,
    )
    if (this.#isStale(gen)) return
    if (!this.#canTouchDom(gen, body)) return
    if (buf.byteLength > PDF_MAX_SIZE) {
      body.innerHTML = `<p style="color:var(--text-tertiary)">${t('pdfTooLarge')}</p>`
      return
    }

    const parseTotal = buf.byteLength
    this.#setPdfProgress(body, gen, {
      label: t('pdfLoadingParse'),
      loaded: 0,
      total: parseTotal,
      pct: PDF_DL_WEIGHT * 100,
    })
    const pdf = await this.#loadPdfDocument(
      buf,
      gen,
      (loaded, parseSize) => {
        const effectiveTotal = parseSize > 0 ? parseSize : parseTotal
        const ratio = effectiveTotal > 0 ? loaded / effectiveTotal : 0
        this.#setPdfProgress(body, gen, {
          label: t('pdfLoadingParse'),
          loaded,
          total: effectiveTotal,
          pct: (PDF_DL_WEIGHT + ratio * PDF_PARSE_WEIGHT) * 100,
          indeterminate: effectiveTotal <= 0,
        })
      },
      signal,
      getBaseName(extractFileName(key)),
    )
    if (this.#isStale(gen)) return
    if (!this.#canTouchDom(gen, body)) return
    this.#pdfDoc = pdf

    body.innerHTML = ''
    body.classList.add('pdf-body')
    const viewer = document.createElement('div')
    viewer.className = 'pdf-viewer'
    body.appendChild(viewer)

    const url = this.#r2.getPublicUrl(key) ?? (await this.#r2.getPresignedUrl(key))
    if (!this.#canTouchDom(gen, body)) return
    this.#currentUrl = url
    copyBtn.dataset.tooltip = t('copyLink')
    copyBtn.hidden = false
    previewFullscreenBtn().hidden = false

    for (let p = 1; p <= pdf.numPages; p++) {
      if (signal?.aborted || this.#isStale(gen) || !this.#canTouchDom(gen, body)) return

      const pageEl = document.createElement('div')
      pageEl.className = 'pdf-page'
      const canvas = document.createElement('canvas')
      pageEl.appendChild(canvas)
      viewer.appendChild(pageEl)

      const page = await this.#pdfDoc.getPage(p)
      if (signal?.aborted || this.#isStale(gen) || !this.#canTouchDom(gen, body)) return

      const width = viewer.clientWidth || body.clientWidth || 800
      const baseViewport = page.getViewport({ scale: 1 })
      const scale = width / baseViewport.width
      const viewport = page.getViewport({ scale })
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      canvas.width = viewport.width
      canvas.height = viewport.height
      const renderTask = page.render({ canvasContext: ctx, viewport })
      this.#pdfRenderTasks.push(renderTask)
      try {
        await renderTask.promise
      } catch (/** @type {any} */ err) {
        if (err?.name === 'RenderingCancelledException') return
        throw err
      } finally {
        const i = this.#pdfRenderTasks.indexOf(renderTask)
        if (i >= 0) this.#pdfRenderTasks.splice(i, 1)
      }
    }
  }

  /** @param {{key: string, size?: number, lastModified?: number}} item */
  async preview(item) {
    const key = item.key
    this.#currentKey = key
    this.#currentText = ''
    this.#currentUrl = ''
    this.#previewGen++
    const gen = this.#previewGen
    this.#abortLoad()
    this.#cleanupPdf()
    this.#loadAbort = new AbortController()
    const signal = this.#loadAbort.signal
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
      let contentLength = item.size ?? 0
      try {
        const head = await this.#r2.headObject(key, signal)
        if (this.#isStale(gen)) return
        if (head.contentType) realContentType = head.contentType
        if (head.contentLength > 0) contentLength = head.contentLength
      } catch (/** @type {any} */ err) {
        if (err?.name === 'AbortError') return
      }

      const meta = {
        contentLength,
        contentType: realContentType,
        lastModified: item.lastModified ? new Date(item.lastModified) : undefined,
      }

      if (!this.#canTouchDom(gen, body)) return

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
        await this.#renderPdf(key, body, copyBtn, gen, meta.contentLength)
      } else {
        body.innerHTML = `<p style="color:var(--text-tertiary)">${t('previewNotAvailable')}</p>`
      }
    } catch (/** @type {any} */ err) {
      if (err?.name === 'AbortError') return
      if (!this.#canTouchDom(gen, body)) return
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
