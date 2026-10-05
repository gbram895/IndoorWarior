// Bluetooth smart trainer support via Web Bluetooth.
//
// Primary: FTMS (Fitness Machine Service, 0x1826), used by the Van Rysel D100
// and most modern trainers. Reads power/cadence/speed and sets resistance with
// "indoor bike simulation" (gradient) commands.
// Fallback: Cycling Power Service (0x1818), read-only (no resistance control).

export const FTMS_SERVICE = 0x1826;
export const INDOOR_BIKE_DATA = 0x2ad2;
export const FTMS_CONTROL_POINT = 0x2ad9;
export const CPS_SERVICE = 0x1818;
export const CPS_MEASUREMENT = 0x2a63;
export const HR_SERVICE = 0x180d;
export const HR_MEASUREMENT = 0x2a37;

export const OP = {
  REQUEST_CONTROL: 0x00,
  RESET: 0x01,
  START: 0x07,
  SET_SIMULATION: 0x11,
  RESPONSE: 0x80,
};

export const RESULT = {
  1: 'success',
  2: 'op code not supported',
  3: 'invalid parameter',
  4: 'operation failed',
  5: 'control not permitted',
};

/** Parse an FTMS Indoor Bike Data notification. */
export function parseIndoorBikeData(view) {
  const flags = view.getUint16(0, true);
  let o = 2;
  const out = { speedKmh: null, cadence: null, power: null, heartRate: null };
  // Bit 0 is "More Data": when CLEAR, instantaneous speed is present.
  if (!(flags & 0x0001)) {
    out.speedKmh = view.getUint16(o, true) / 100;
    o += 2;
  }
  if (flags & 0x0002) o += 2; // average speed
  if (flags & 0x0004) {
    out.cadence = view.getUint16(o, true) / 2;
    o += 2;
  }
  if (flags & 0x0008) o += 2; // average cadence
  if (flags & 0x0010) o += 3; // total distance
  if (flags & 0x0020) o += 2; // resistance level
  if (flags & 0x0040) {
    out.power = view.getInt16(o, true);
    o += 2;
  }
  if (flags & 0x0080) o += 2; // average power
  if (flags & 0x0100) o += 5; // expended energy
  if (flags & 0x0200) {
    out.heartRate = view.getUint8(o);
    o += 1;
  }
  return out;
}

/** Encode "Set Indoor Bike Simulation Parameters" (op 0x11). `grade` is a fraction. */
export function encodeSimulation({ grade, windSpeed = 0, crr = 0.004, cw = 0.51 }) {
  const buf = new DataView(new ArrayBuffer(7));
  const clamp16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
  buf.setUint8(0, OP.SET_SIMULATION);
  buf.setInt16(1, clamp16(windSpeed * 1000), true); // 0.001 m/s
  buf.setInt16(3, clamp16(grade * 10000), true); // 0.01 %
  buf.setUint8(5, Math.max(0, Math.min(255, Math.round(crr * 10000)))); // 0.0001
  buf.setUint8(6, Math.max(0, Math.min(255, Math.round(cw * 100)))); // 0.01 kg/m
  return new Uint8Array(buf.buffer);
}

/** Parse a control point indication: [0x80, requestOp, resultCode]. */
export function parseControlResponse(view) {
  if (view.byteLength < 3 || view.getUint8(0) !== OP.RESPONSE) return null;
  const code = view.getUint8(2);
  return { op: view.getUint8(1), code, ok: code === 1, result: RESULT[code] ?? `code ${code}` };
}

/** Parse a Cycling Power Measurement: power plus crank data if present. */
export function parseCyclingPower(view) {
  const flags = view.getUint16(0, true);
  const out = { power: view.getInt16(2, true), crankRevs: null, crankTime: null };
  let o = 4;
  if (flags & 0x0001) o += 1; // pedal power balance
  if (flags & 0x0004) o += 2; // accumulated torque
  if (flags & 0x0010) o += 6; // wheel revolutions
  if (flags & 0x0020) {
    out.crankRevs = view.getUint16(o, true);
    out.crankTime = view.getUint16(o + 2, true); // 1/1024 s
  }
  return out;
}

export function parseHeartRate(view) {
  const flags = view.getUint8(0);
  return flags & 0x01 ? view.getUint16(1, true) : view.getUint8(1);
}

/** Turns cumulative crank revolution counters into cadence (rpm). */
export class CrankCadence {
  constructor() {
    this.last = null;
    this.cadence = 0;
    this.lastChange = 0;
  }

  update(revs, time, now = Date.now()) {
    if (revs == null) return null;
    if (this.last) {
      const dRevs = (revs - this.last.revs) & 0xffff;
      const dTime = (time - this.last.time) & 0xffff;
      if (dRevs > 0 && dTime > 0) {
        this.cadence = (dRevs / (dTime / 1024)) * 60;
        this.lastChange = now;
      } else if (now - this.lastChange > 3000) {
        this.cadence = 0;
      }
    }
    this.last = { revs, time };
    return Math.round(this.cadence);
  }
}

export function bluetoothAvailability() {
  if (typeof navigator === 'undefined' || !navigator.bluetooth) {
    return 'This browser has no Web Bluetooth. Use Chrome or Edge on desktop or Android (on iPhone, the Bluefy browser).';
  }
  if (!window.isSecureContext) return 'Bluetooth needs https:// or http://localhost.';
  return null;
}

/**
 * A connected Bluetooth trainer. Emits:
 *  - 'data'          detail: {power, cadence, speedKmh, heartRate}
 *  - 'disconnected'
 */
export class BleTrainer extends EventTarget {
  static async request() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS_SERVICE] }, { services: [CPS_SERVICE] }],
      optionalServices: [FTMS_SERVICE, CPS_SERVICE, HR_SERVICE],
    });
    const trainer = new BleTrainer(device);
    await trainer.connect();
    return trainer;
  }

  constructor(device) {
    super();
    this.device = device;
    this.name = device.name || 'Smart trainer';
    this.canControl = false;
    this.protocol = null;
    this.controlError = null;
    this._queue = Promise.resolve();
    this._pending = null;
    this._targetGrade = 0;
    this._sentGrade = null;
    this._busy = false;
    this._gradeTimer = null;
    this.simulation = { crr: 0.004, cw: 0.51 };
  }

  async connect() {
    this.device.addEventListener('gattserverdisconnected', () => {
      clearInterval(this._gradeTimer);
      this.dispatchEvent(new Event('disconnected'));
    });
    const server = await this.device.gatt.connect();
    let ftms = null;
    try {
      ftms = await server.getPrimaryService(FTMS_SERVICE);
    } catch {
      /* not an FTMS trainer */
    }
    if (ftms) await this._setupFtms(ftms);
    else await this._setupCps(await server.getPrimaryService(CPS_SERVICE));
  }

  async _setupFtms(service) {
    this.protocol = 'FTMS';
    const data = await service.getCharacteristic(INDOOR_BIKE_DATA);
    data.addEventListener('characteristicvaluechanged', (e) => this._emit(parseIndoorBikeData(e.target.value)));
    await data.startNotifications();

    try {
      this.cp = await service.getCharacteristic(FTMS_CONTROL_POINT);
      this.cp.addEventListener('characteristicvaluechanged', (e) => this._onControlResponse(e.target.value));
      await this.cp.startNotifications();
      const control = await this._command([OP.REQUEST_CONTROL]);
      if (control && !control.ok) throw new Error(`trainer refused control (${control.result})`);
      await this._command([OP.START]);
      this.canControl = true;
      this._gradeTimer = setInterval(() => this._flushGrade(), 1000);
    } catch (err) {
      this.controlError = err.message;
      console.warn('FTMS control unavailable:', err);
    }
  }

  async _setupCps(service) {
    this.protocol = 'Cycling Power';
    const cadence = new CrankCadence();
    const meas = await service.getCharacteristic(CPS_MEASUREMENT);
    meas.addEventListener('characteristicvaluechanged', (e) => {
      const p = parseCyclingPower(e.target.value);
      this._emit({ power: p.power, cadence: cadence.update(p.crankRevs, p.crankTime), speedKmh: null, heartRate: null });
    });
    await meas.startNotifications();
  }

  _emit(detail) {
    this.dispatchEvent(new CustomEvent('data', { detail }));
  }

  _onControlResponse(view) {
    const res = parseControlResponse(view);
    if (res && this._pending && res.op === this._pending.op) {
      this._pending.resolve(res);
      this._pending = null;
    }
  }

  /** Write a control point command; resolves with the trainer's response (or null on timeout). */
  _command(bytes) {
    const run = () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pending = null;
          resolve(null);
        }, 3000);
        this._pending = {
          op: bytes[0],
          resolve: (r) => {
            clearTimeout(timer);
            resolve(r);
          },
        };
        this.cp.writeValueWithResponse(new Uint8Array(bytes)).catch((err) => {
          clearTimeout(timer);
          this._pending = null;
          reject(err);
        });
      });
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  /** Ask the trainer to simulate `grade` (fraction). Sent at most once a second. */
  setGrade(grade) {
    this._targetGrade = grade;
  }

  async _flushGrade() {
    if (!this.canControl || this._busy) return;
    const grade = Math.round(this._targetGrade * 1000) / 1000; // 0.1 % resolution
    if (this._sentGrade !== null && Math.abs(grade - this._sentGrade) < 0.001) return;
    this._busy = true;
    try {
      await this._command(Array.from(encodeSimulation({ grade, ...this.simulation })));
      this._sentGrade = grade;
    } catch (err) {
      console.warn('Failed to send gradient', err);
    } finally {
      this._busy = false;
    }
  }

  disconnect() {
    clearInterval(this._gradeTimer);
    if (this.device.gatt.connected) this.device.gatt.disconnect();
  }
}

/** Optional Bluetooth heart-rate strap. Emits 'hr' with detail = bpm. */
export class HeartRateMonitor extends EventTarget {
  static async request() {
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [HR_SERVICE] }] });
    const hrm = new HeartRateMonitor(device);
    const server = await device.gatt.connect();
    const ch = await (await server.getPrimaryService(HR_SERVICE)).getCharacteristic(HR_MEASUREMENT);
    ch.addEventListener('characteristicvaluechanged', (e) =>
      hrm.dispatchEvent(new CustomEvent('hr', { detail: parseHeartRate(e.target.value) })),
    );
    await ch.startNotifications();
    device.addEventListener('gattserverdisconnected', () => hrm.dispatchEvent(new Event('disconnected')));
    return hrm;
  }

  constructor(device) {
    super();
    this.device = device;
    this.name = device.name || 'Heart rate';
  }

  disconnect() {
    if (this.device.gatt.connected) this.device.gatt.disconnect();
  }
}
