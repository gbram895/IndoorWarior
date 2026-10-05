// Turns rider power into road speed using the standard cycling power model:
// gravity + rolling resistance + aerodynamic drag.

export const G = 9.80665;

export const DEFAULT_RIDER = {
  riderKg: 75,
  bikeKg: 9,
  cda: 0.32, // drag area (m²), hoods position
  crr: 0.004, // rolling resistance, good road tyres
  airDensity: 1.225, // kg/m³ at sea level
  drivetrainEfficiency: 0.97,
};

/** Total force (N) opposing motion at `speed` (m/s) on `grade` (fraction, 0.05 = 5%). */
export function resistiveForce(speed, grade, rider = DEFAULT_RIDER) {
  const mass = rider.riderKg + rider.bikeKg;
  const theta = Math.atan(grade);
  const gravity = mass * G * Math.sin(theta);
  const rolling = mass * G * rider.crr * Math.cos(theta);
  const drag = 0.5 * rider.airDensity * rider.cda * speed * speed;
  return gravity + rolling + drag;
}

/** Advance speed by `dt` seconds given rider `power` (W). Never goes backwards. */
export function stepSpeed(speed, power, grade, dt, rider = DEFAULT_RIDER) {
  const mass = rider.riderKg + rider.bikeKg;
  const steps = Math.max(1, Math.ceil(dt / 0.05));
  const h = dt / steps;
  let v = speed;
  for (let i = 0; i < steps; i++) {
    // Below 1 m/s, cap drive force so standing starts stay finite.
    const drive = (Math.max(0, power) * rider.drivetrainEfficiency) / Math.max(v, 1);
    const accel = (drive - resistiveForce(v, grade, rider)) / mass;
    v = Math.max(0, v + accel * h);
  }
  return v;
}

/** Speed (m/s) a rider settles at holding `power` on `grade`. */
export function steadyStateSpeed(power, grade, rider = DEFAULT_RIDER) {
  let lo = 0;
  let hi = 40;
  const net = (v) => (power * rider.drivetrainEfficiency) / Math.max(v, 1e-6) - resistiveForce(v, grade, rider);
  if (net(1e-3) <= 0) return 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (net(mid) > 0) lo = mid;
    else hi = mid;
  }
  return lo;
}
