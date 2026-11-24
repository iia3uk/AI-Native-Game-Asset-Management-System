import { ModelStage } from './stage.js'

export class ModelThumbnails {
  constructor(root) {
    this.cache = new Map()
    this.targets = new WeakMap()
    this.pending = new Map()
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        const target = entry.target
        this.observer.unobserve(target)
        const job = this.targets.get(target)
        if (job && target.isConnected) this.queue(target, job)
      }
    }, { root })
  }

  observe(target, key, load, fallback) {
    if (this.cache.has(key)) {
      this.paint(target, this.cache.get(key) ?? fallback)
      return
    }
    this.targets.set(target, { key, load, fallback })
    this.observer.observe(target)
  }

  clearObserved() {
    this.observer.disconnect()
  }

  paint(target, src) {
    if (!src) return
    const image = document.createElement('img')
    image.alt = ''
    image.src = src
    image.addEventListener('load', () => { if (target.isConnected) target.replaceChildren(image) }, { once: true })
  }

  queue(target, job) {
    if (this.cache.has(job.key)) this.paint(target, this.cache.get(job.key) ?? job.fallback)
    else {
      const pending = this.pending.get(job.key)
      if (pending) pending.targets.push(target)
      else this.pending.set(job.key, { ...job, targets: [target] })
      void this.run()
    }
  }

  async run() {
    if (this.running) return
    this.running = true
    try {
      for (const [key, job] of this.pending) {
        if (!job.targets.some(target => target.isConnected)) { this.pending.delete(key); continue }
        let image = null
        try { image = await this.render(await job.load()) } catch { /* the card can use its supplied fallback image */ }
        this.cache.set(key, image)
        if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value)
        this.pending.delete(key)
        for (const target of job.targets) if (target.isConnected) this.paint(target, image ?? job.fallback)
      }
    } finally {
      this.running = false
    }
  }

  async render({ files, resources, unityMaterials }) {
    if (!files.length) return null
    if (!this.stage) {
      this.stage = new ModelStage(document.createElement('div'))
      this.stage.renderer.setAnimationLoop(null)
      this.stage.observer.disconnect()
      this.stage.renderer.setPixelRatio(1)
      this.stage.renderer.setSize(144, 144, false)
      this.stage.camera.aspect = 1
      this.stage.camera.updateProjectionMatrix()
      this.stage.renderer.setClearColor(0x263425, 1)
      this.stage.grid.visible = false
    }
    for (const file of files) {
      try {
        const result = await this.stage.load(file, resources, unityMaterials)
        if (!result || result.empty || result.skeletonOnly) continue
        this.stage.renderer.render(this.stage.scene, this.stage.camera)
        return this.stage.renderer.domElement.toDataURL('image/jpeg', .82)
      } catch { /* try the next model in the pack */ }
      finally { this.stage.clear() }
    }
    return null
  }
}
