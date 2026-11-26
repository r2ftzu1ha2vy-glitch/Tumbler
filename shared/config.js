// Single home for every tunable and every asset-dependent fact.
//
// Provenance tags:
//   [USER]   you stated it in the request
//   [GLB]    verified against your .glb files (test/glb.test.js re-checks it on every run).
//            The live values are READ FROM THE FILES at load; nothing here is a copy of them.
//   [DESIGN] my game-design choice. Uncalibrated: tune by feel in play.
//
// World convention: Y up, right-handed (three.js), metres.
// Yaw convention:   yaw 0 faces +Z, positive yaw turns toward +X.  forward = (sin yaw, cos yaw) in (x, z).

export const CONFIG = Object.freeze({
  MAX_PLAYERS: 5,          // [USER] "add bots for less than 5 people": every match is filled up to 5 with bots
  COUNTDOWN_S: 5,          // [USER] "after 5 secs you get teleported into a random position"

  PLAN_TIME_S: 12,         // [DESIGN] aim + power phase length before everyone slides
  DEFAULT_POWER: 0.5,      // [DESIGN]
  MIN_POWER: 0.1,          // [DESIGN] floor so nobody can stall a match at 0 distance
  MAX_SLIDE_M: 14,         // [DESIGN] power 1.0 = 14 m of travel on an unobstructed slide (grid is 15 m wide [GLB])
  FRICTION_MPS2: 6,        // [DESIGN] constant deceleration while sliding; with MAX_SLIDE_M gives ~13 m/s launch
  DUCK_RADIUS_M: 0.4,      // [DESIGN] collision circle; duck footprint from the GLB is x +-0.367, z -0.5..+0.6875
  RESTITUTION: 0.9,        // [DESIGN] duck-vs-duck bounciness (equal masses)
  GRAVITY_MPS2: 22,        // [DESIGN] used once a duck has left the grid
  FALL_KILL_DEPTH_M: 25,   // [DESIGN] a fallen duck is removed this far below the grid top
  SETTLE_SPEED_MPS: 0.05,  // [DESIGN] below this everything counts as stopped
  SLIDE_MAX_S: 8,          // [DESIGN] hard cap on one slide phase

  SPAWN_EDGE_MARGIN_M: 1.2,      // [DESIGN] teleport spawns at least this far from any edge
  SPAWN_MIN_SEPARATION_M: 2.0,   // [DESIGN] and at least this far from each other (relaxed if the grid is too crowded)

  BOT_THINK_MIN_S: 1.2,    // [DESIGN]
  BOT_THINK_MAX_S: 5.0,    // [DESIGN]
  BOT_AIM_ERR_RAD: 0.07,   // [DESIGN] bot aim noise, so bots can be beaten
  BOT_POWER_ERR: 0.04,     // [DESIGN]
  BOT_ATTACK_CHANCE: 0.7,  // [DESIGN] chance a bot goes for an opponent this round (else it repositions)
  BOT_RECKLESS_AFTER_ROUND: 10, // [DESIGN] bots stop avoiding their own edge-risk so a long endgame resolves

  TICK_HZ: 60,             // [DESIGN] fixed simulation rate (client offline mode and server)
  SNAPSHOT_HZ: 20,         // [DESIGN] server -> client snapshot rate
  INTERP_DELAY_MS: 100,    // [DESIGN] client render delay for snapshot interpolation

  POWER_RATE_PER_S: 0.45,  // [DESIGN] power change per second while up/down is held
  POWER_WHEEL_STEP: 0.05,  // [DESIGN] power change per mouse-wheel notch
  MOUSE_SENS_RAD_PER_PX: 0.0026, // [DESIGN] uncalibrated mouse sensitivity
});

export const ASSETS = Object.freeze({
  GRID_GLB: './assets/Grid.glb',
  DUCK_GLB: './assets/TumblerDuck.glb',
  // [GLB] clip names exist in TumblerDuck.glb: idle (3.0 s, loop), sit_down (1.0 s), stand_up (1.0 s).
  // sit_down lowers the body 0.25 m and lifts the legs (belly-slide pose); stand_up is the exact reverse.
  DUCK_ANIMS: Object.freeze({ IDLE: 'idle', SIT: 'sit_down', STAND: 'stand_up' }),
  // [DESIGN] playback speed for sit_down so the pose lands as the slide starts.
  SIT_TIMESCALE: 2.5,
});

export const PLAYER_COLORS = Object.freeze(['#ffd23f', '#ff6b9d', '#4ecdc4', '#a78bfa', '#ff8c42']); // [DESIGN]
