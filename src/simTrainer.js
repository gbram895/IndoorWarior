// A pretend trainer for testing without hardware. Same interface as BleTrainer.

export class SimulatedTrainer extends EventTarget {
  constructor() {
    super();
    this.name = 'Simulated trainer';
    this.protocol = 'Simulation';
    this.canControl = true;
    this.power = 150;
    this.grade = 0;
    this._timer = setInterval(() => this._tick(), 250);
  }

  setPower(watts) {
    this.power = Math.max(0, Math.min(2000, Math.round(watts)));
  }

  setGrade(grade) {
    this.grade = grade;
  }

  _tick() {
    const jitter = (Math.random() - 0.5) * this.power * 0.06;
    const power = this.power > 0 ? Math.max(0, Math.round(this.power + jitter)) : 0;
    const cadence = power > 0 ? Math.round(Math.min(110, 78 + power / 25 + (Math.random() - 0.5) * 3)) : 0;
    this.dispatchEvent(new CustomEvent('data', { detail: { power, cadence, speedKmh: null, heartRate: null } }));
  }

  disconnect() {
    clearInterval(this._timer);
  }
}
