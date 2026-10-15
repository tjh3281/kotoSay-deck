/* ==========================================================================
   Spring — Apple-style parameters (damping ratio + response), not a duration.
     damping 1.0  → critically damped, no overshoot (default for UI)
     damping ~0.8 → a little bounce, only after a gesture that carried momentum
     response     → seconds to (roughly) reach the target; lower = snappier
   Springs animate from the current (presentation) value and keep velocity
   when retargeted, so every transition can be interrupted and reversed.
   ========================================================================== */

class Spring {
  constructor(value = 0) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.damping = 1;
    this.response = 0.42;
  }

  configure({ damping, response }) {
    if (damping !== undefined) this.damping = damping;
    if (response !== undefined) this.response = response;
    return this;
  }

  /* Mass = 1, stiffness = (2π / response)², damping coeff = 4π·ζ / response */
  step(dt) {
    const omega = (2 * Math.PI) / this.response;
    const k = omega * omega;
    const c = 2 * this.damping * omega;
    const h = 1 / 240;                       // fixed sub-steps keep it stable at any frame rate
    let remaining = dt;
    while (remaining > 0) {
      const s = Math.min(h, remaining);
      const accel = -k * (this.value - this.target) - c * this.velocity;
      this.velocity += accel * s;
      this.value += this.velocity * s;
      remaining -= s;
    }
  }

  get resting() {
    return Math.abs(this.value - this.target) < 1e-4 && Math.abs(this.velocity) < 1e-3;
  }

  settle() { this.value = this.target; this.velocity = 0; }

  jump(v) { this.value = this.target = v; this.velocity = 0; }
}

/* Where a flick will come to rest — Apple's projection (Designing Fluid Interfaces).
   Exponential decay, not v²/2a. decelerationRate 0.998 ≈ normal scroll feel. */
function projectMomentum(velocityPxPerSec, decelerationRate = 0.998) {
  return ((velocityPxPerSec / 1000) * decelerationRate) / (1 - decelerationRate);
}

/* Soft boundary: the further past the edge, the less the content follows. */
function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}
