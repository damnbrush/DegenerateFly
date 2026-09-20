/* Headless smoke test + pose screenshots. Development tool, not the game.
   node shoot.mjs            → one frame per pose, plus a wide shot
   node shoot.mjs live       → four frames of the game running itself
   node shoot.mjs acc        → tight frames on the hat and the bow           */
import puppeteer from "puppeteer";

const live = process.argv.includes("live");
const acc = process.argv.includes("acc");
const floor = process.argv.includes("floor");
const moves = process.argv.includes("moves");
const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--disable-gpu-sandbox", "--no-sandbox", "--window-size=1600,1100",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1100, deviceScaleFactor: 1 });

const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(`[error] ${m.text()}`); });
page.on("pageerror", (e) => problems.push(`[pageerror] ${e.message}`));

await page.goto("http://127.0.0.1:8000/", { waitUntil: "networkidle2", timeout: 90000 });
await new Promise((r) => setTimeout(r, 5000));

if (!(await page.evaluate(() => !!window.__stage))) {
  console.log("stage never booted:\n" + [...new Set(problems)].join("\n"));
  await browser.close();
  process.exit(1);
}

const box = await page.evaluate(() => {
  const r = document.getElementById("stage").getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
});
const shoot = (name) => page.screenshot({ path: `shot_${name}.png`, clip: box });

if (live) {
  for (const n of ["live1", "live2", "live3", "live4"]) {
    await shoot(n);
    await new Promise((r) => setTimeout(r, 5000));
  }
} else if (floor) {
  /* The bug this checks for: a repeated down state used to stand the fly back
     up and topple it again. Record where the rig is at each step, so a jump
     back to the stool shows up as a number and not just a hunch. */
  await page.evaluate(() => {
    const b = document.getElementById("btnAuto");
    if (b && b.textContent.trim() === "Пауза") b.click();
  });
  await new Promise((r) => setTimeout(r, 2000));
  const steps = ["fall", "fall", "down", "down", "fall", "climb", "idle"];
  for (let i = 0; i < steps.length; i++) {
    /* let the game's own director frame it, so this checks the real shot */
    await page.evaluate((p) => {
      window.__stage.notePose("male", { pose: p });
      window.__stage.focus("male");
      window.__stage.debug.freeCamera();
    }, steps[i]);
    await new Promise((r) => setTimeout(r, 5200));
    const at = await page.evaluate(() => {
      const r = window.__stage.debug.flies.male;
      return { pose: r.pose, place: r.place, y: +r.root.position.y.toFixed(3), x: +r.root.position.x.toFixed(3) };
    });
    console.log(`sent ${steps[i]} -> pose=${at.pose} place=${at.place} x=${at.x} y=${at.y}`);
    await shoot(`floor${i}_${steps[i]}`);
  }
} else if (moves) {
  /* One frame per new action, shot through the game's own director, so this
     checks the camera as much as the pose. Two frames each: partway in and
     near the end, because most of these read differently at the two points. */
  /* Stop the game at the source. Turning autopilot off is not enough and
     nor is clicking the button: the page keeps polling, and every reply
     re-poses both flies and drags the camera off whatever we set. Cutting
     the tick at the fetch is the only way to hold a pose still. */
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = (u, o) => (String(u).includes("/api/tick")
      ? new Promise(() => {})
      : real(u, o));
  });
  await new Promise((r) => setTimeout(r, 2500));
  const all = ["groom", "work", "scrounge", "lamp", "ceiling", "sing", "toast", "shove", "bubble"];
  const only = process.argv.filter((x) => all.includes(x));
  const acts = only.length ? only : all;
  for (const a of acts) {
    await page.evaluate((p) => {
      window.__stage.notePose("male", { pose: p });
      if (p === "toast") window.__stage.notePose("female", { pose: p });
      window.__stage.focus("male");
      window.__stage.debug.freeCamera();
      /* the props and impacts ride on the effect payload, not the pose, so
         the rag and the sparks only show up if this fires too */
      window.__stage.triggerFx({ sex: "male", kind: p, hold_ms: 4600, found: 2, toppled: true });
    }, a);
    /* Wait on the rig's own clock, not the wall's. Under swiftshader this
       page renders at a few frames a second and updateFly advances rig.t by
       the frame delta, so sim time runs at a fraction of real time — timing
       these frames with setTimeout shot every pose on the wrong beat. */
    const until = async (frac) => {
      for (let i = 0; i < 400; i++) {
        const u = await page.evaluate(() => {
          const r = window.__stage.debug.flies.male;
          return r.t / r.dur;
        });
        if (u >= frac) return u;
        await new Promise((r) => setTimeout(r, 120));
      }
      return -1;
    };
    for (const [tag, frac] of [["a", 0.45], ["b", 0.82]]) {
      const u = await until(frac);
      await shoot(`mv_${a}_${tag}`);
      if (tag === "a") process.stdout.write(`${a.padEnd(9)} u=${u.toFixed(2)} `);
    }
    const now = await page.evaluate(() => {
      const r = window.__stage.debug.flies.male;
      return { pose: r.pose, place: r.place, p: r.root.position.toArray().map((n) => +n.toFixed(2)) };
    });
    console.log(`pose=${now.pose.padEnd(9)} place=${now.place} at ${now.p.join(",")}`);
    await until(1.0);
  }
} else if (acc) {
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = (u, o) => (String(u).includes("/api/tick")
      ? new Promise(() => {})
      : real(u, o));
    window.__stage.notePose("male", { pose: "idle" });
    window.__stage.notePose("female", { pose: "idle" });
  });
  await new Promise((r) => setTimeout(r, 3500));

  /* Stay well outside the bar geometry and crop in with a long lens instead
     of flying the camera up to the hat, which lands it inside the shelf. */
  for (const sex of ["male", "female"]) {
    const sx = sex === "male" ? 1 : -1;
    /* The face direction straight from the geometry: head minus thorax. No
       guessing which local axis the rig was built along. */
    const { w, f } = await page.evaluate((s) => {
      const r = window.__stage.debug.flies[s];
      const hat = r.hat.getWorldPosition(r.hat.position.clone());
      const head = r.head.getWorldPosition(r.head.position.clone());
      const thorax = r.thorax.getWorldPosition(r.thorax.position.clone());
      const d = head.sub(thorax).setY(0).normalize();
      return { w: [hat.x, hat.y, hat.z], f: [d.x, d.y, d.z] };
    }, sex);
    console.log(sex, "hat", w.map((n) => n.toFixed(2)).join(","), "face", f.map((n) => n.toFixed(2)).join(","));
    const R = 1.5;
    const ring = (deg, lift) => {
      const a = Math.atan2(f[0], f[2]) + (deg * Math.PI) / 180;
      return [w[0] + Math.sin(a) * R, w[1] + lift, w[2] + Math.cos(a) * R];
    };
    const views = [
      ["front", ring(0, 0.12), 26],
      ["three", ring(sx * 45, 0.16), 26],
      ["side", ring(sx * 90, 0.06), 26],
      ["top", ring(sx * 30, 1.3), 30],
    ];
    for (const [tag, pos, fov] of views) {
      await page.evaluate((s, p, f, t) => {
        const d = window.__stage.debug;
        window.__stage.notePose(s, { pose: "idle" });
        d.camera.position.set(p[0], p[1], p[2]);
        d.controls.target.set(t[0], t[1], t[2]);
        d.camera.fov = f;
        d.camera.updateProjectionMatrix();
        d.holdCamera();
      }, sex, pos, fov, w);
      await new Promise((r) => setTimeout(r, 1200));
      await shoot(`acc_${sex}_${tag}`);
    }
  }
} else {
  /* stop the game driving the rigs, then pose them by hand */
  await page.evaluate(() => {
    const b = document.getElementById("btnAuto");
    if (b && b.textContent.trim() === "Пауза") b.click();
  });
  await new Promise((r) => setTimeout(r, 2500));

  const setCam = (pos, target) => page.evaluate((p, t) => {
    const d = window.__stage.debug;
    d.camera.position.set(p[0], p[1], p[2]);
    d.controls.target.set(t[0], t[1], t[2]);
    d.camera.fov = 34;
    d.camera.updateProjectionMatrix();
    d.holdCamera();
  }, pos, target);

  await setCam([2.6, 1.9, 4.0], [0, 1.15, -0.4]);
  await new Promise((r) => setTimeout(r, 2500));
  await shoot("wide");

  /* the mirrored overview */
  await setCam([-2.6, 1.9, 4.0], [0, 1.15, -0.4]);
  await new Promise((r) => setTimeout(r, 2500));
  await shoot("wide2");

  /* a lower, nearer overview that still holds both stools */
  await setCam([1.5, 1.35, 2.9], [0, 1.18, -0.3]);
  await new Promise((r) => setTimeout(r, 2500));
  await shoot("low");

  /* dev only: a mid shot of each rig, to check the build not the framing */
  await setCam([1.1, 1.5, 1.55], [0.95, 1.28, 0.2]);
  await new Promise((r) => setTimeout(r, 2500));
  await shoot("rig_m");
  await setCam([-1.1, 1.5, 1.55], [-0.95, 1.28, 0.2]);
  await new Promise((r) => setTimeout(r, 2500));
  await shoot("rig_f");


  const poses = ["drink", "spin", "win", "lose", "steal", "fall", "beg", "nap"];
  for (const pose of poses) {
    await page.evaluate((p) => {
      window.__stage.notePose("male", { pose: p });
      window.__stage.notePose("female", { pose: p === "drink" ? "lose" : "drink" });
      window.__stage.focus("male");
      window.__stage.debug.freeCamera();
    }, pose);
    /* let the director frame it, then catch the middle of the action */
    await new Promise((r) => setTimeout(r, 1500));
    await shoot(pose);
    await new Promise((r) => setTimeout(r, 900));
  }
}

console.log(problems.length ? "PROBLEMS:\n" + [...new Set(problems)].slice(0, 20).join("\n") : "no console errors");
await browser.close();
