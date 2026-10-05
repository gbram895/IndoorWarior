// Formatting helpers and the elevation profile strip.

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export const formatKm = (metres) => (metres / 1000).toFixed(metres < 10000 ? 2 : 1);

export function gradeColor(grade) {
  const pct = grade * 100;
  if (pct < -1) return '#4cc9f0';
  if (pct < 2) return '#7bd389';
  if (pct < 5) return '#f4d35e';
  if (pct < 8) return '#f78c3b';
  return '#e63946';
}

export class ProfileView {
  constructor(canvas) {
    this.canvas = canvas;
    this.route = null;
    this.cache = null;
    window.addEventListener('resize', () => (this.cache = null));
  }

  setRoute(route) {
    this.route = route;
    this.cache = null;
  }

  _render() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    this.canvas.width = w;
    this.canvas.height = h;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const g = off.getContext('2d');
    const r = this.route;
    const pad = 6 * dpr;
    const range = Math.max(20, r.maxEle - r.minEle);
    this.yOf = (ele) => h - pad - ((ele - r.minEle) / range) * (h - 2 * pad);
    this.xOf = (d) => (d / r.length) * w;
    for (let px = 0; px < w; px++) {
      const s = r.sample(((px + 0.5) / w) * r.length);
      g.fillStyle = gradeColor(s.grade);
      g.globalAlpha = 0.85;
      g.fillRect(px, this.yOf(s.y), 1, h);
    }
    this.cache = off;
  }

  /** @param {{distance:number, color:string, size?:number}[]} markers */
  draw(markers) {
    if (!this.route) return;
    if (!this.cache || this.canvas.width !== Math.round(this.canvas.clientWidth * Math.min(window.devicePixelRatio || 1, 2))) {
      this._render();
    }
    const g = this.canvas.getContext('2d');
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.cache, 0, 0);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const m of markers) {
      const s = this.route.sample(m.distance);
      const x = this.xOf(s.distance);
      const y = this.yOf(s.y);
      g.beginPath();
      g.arc(x, y, (m.size ?? 4) * dpr, 0, Math.PI * 2);
      g.fillStyle = m.color;
      g.fill();
      g.lineWidth = 1.5 * dpr;
      g.strokeStyle = '#111';
      g.stroke();
    }
  }
}
