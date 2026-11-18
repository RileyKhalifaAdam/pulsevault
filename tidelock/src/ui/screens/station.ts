// Station screen: what the player sees while docked. Market, ship services, departures and the Launch button.
import {
  h, icon, onTap, ICON_NAMES, type IconName,
  Screen, Tabs, SegmentedControl, Button, Stepper, Slider, ProgressBar, KeyValue, Panel, EmptyState, Badge, delta, BottomSheet,
} from '../kit';
import { fmtCredits, fmtDistance, fmtInt, fmtMass, fmtSpeed, fmtPercent, DAY } from '../../core/units';
import type { MarketRow } from '../../sim/economy';
import type { StationDef } from '../../core/types';
import type { UiHost, UiScreen } from '../host';
import { screenRoot, stationKindLabel, firstSentence, put } from './shared';
import { createPauseMenu, type PauseMenu } from './pause';

type Tab = 'market' | 'ship' | 'departures';
type Filter = 'all' | 'cheap' | 'hold';

const LOW_FRACTION = 0.25;
const LOW_DV = 2500;

const catIcon = (cat: string): IconName => ((ICON_NAMES as string[]).includes(cat) ? (cat as IconName) : 'cargo');
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function createStationScreen(host: UiHost): UiScreen {
  const el = screenRoot(host, 'tls-station');
  let tab: Tab = 'market';
  let filter: Filter = 'all';
  let sig = '';
  let poll = 0;
  let pause: PauseMenu | null = null;
  let sheet: { close(): void; sync(): void } | null = null;

  // ---- header
  const eyebrow = h('span');
  const name = h('div.tls-shead__name');
  const menuBtn = h('button.tls-shead__menu', { attrs: { type: 'button', 'aria-label': 'Menu' } }, icon('menu', 22));
  const stat = (k: string): { el: HTMLElement; v: HTMLElement; u: HTMLElement } => {
    const v = h('span');
    const u = h('small');
    return { el: h('div.tls-stat', null, h('div.tls-stat__k', { text: k }), h('div.tls-stat__v.tl-num', null, v, u)), v, u };
  };
  const sCredits = stat('Credits');
  const sHold = stat('Hold');
  const sFuel = stat('Propellant');
  const header = h('div.tls-shead', null,
    h('div.tls-shead__eyebrow', null, icon('station', 14), eyebrow), name, menuBtn,
    h('div.tls-stats', null, sCredits.el, sHold.el, sFuel.el));
  onTap(menuBtn, () => {
    pause ??= createPauseMenu(host);
    pause.show();
  });

  // ---- tabs + footer
  const tabs = Tabs<Tab>({
    items: [{ id: 'market', label: 'Market' }, { id: 'ship', label: 'Ship' }, { id: 'departures', label: 'Departures' }],
    value: tab, fill: true,
    onChange: (id) => { tab = id; render(true); },
  });
  const warn = h('div.tls-warn', null, icon('warning', 18), h('span'));
  const destText = h('span');
  const launch = Button({ label: 'Launch', icon: 'undock', variant: 'primary', size: 'lg', block: true, onTap: doLaunch });
  const mapBtn = Button({ icon: 'map', ariaLabel: 'Orbital map', variant: 'secondary', size: 'lg', onTap: () => host.go('map') });
  const footer = h('div.tls-foot', null, warn,
    h('div.tls-foot__dest', null, h('span.tl-label', { text: 'Destination' }), destText),
    h('div.tls-foot__row', null, mapBtn.el, launch.el));
  const screen = Screen({ header, bar: tabs.el, body: null, footer, flush: true });
  el.appendChild(screen.el);

  function doLaunch(): void {
    const r = host.game.undock();
    if (!r.ok) return host.toast(r.reason, 'bad');
    host.sfx('undock');
    host.saveNow();
    host.go('flight');
  }

  const stationDistance = (a: StationDef, b: StationDef): number => {
    const g = host.game;
    const pa = g.model.stationAbsState(a.id, g.time()).r;
    const ax = pa.x, ay = pa.y, az = pa.z;
    const pb = g.model.stationAbsState(b.id, g.time()).r;
    return Math.hypot(pb.x - ax, pb.y - ay, pb.z - az);
  };

  // ---- header + footer figures (cheap; every poll)
  function refreshChrome(st: StationDef): void {
    const g = host.game;
    const p = g.player();
    const f = g.flightInfo();
    put(eyebrow, `${stationKindLabel(st.visualId)} · orbiting ${g.model.body(st.parentBodyId).name}`);
    put(name, st.name);
    put(sCredits.v, fmtInt(p.credits)); put(sCredits.u, 'cr');
    put(sHold.v, `${fmtInt(p.cargoUsed)} / ${fmtInt(p.cargoCapacity)}`); put(sHold.u, 't');
    put(sFuel.v, fmtPercent(f.propellantFraction, 0)); put(sFuel.u, fmtSpeed(f.deltaV));
    sFuel.v.className = f.propellantFraction < LOW_FRACTION ? 'tls-bad' : '';
    const low = f.propellantFraction < LOW_FRACTION || f.deltaV < LOW_DV;
    warn.style.display = low ? '' : 'none';
    if (low) put(warn.lastElementChild as HTMLElement, `Tanks at ${fmtPercent(f.propellantFraction, 0)} — ${fmtSpeed(f.deltaV)} of Δv. The run to Gloaming Lock and back wants about 3.6 km/s. Refuel under Ship.`);
    const t = g.target();
    const ts = t && t.kind === 'station' ? g.system.stations.find((s) => s.id === t.id) : null;
    if (ts && ts.id !== st.id) {
      put(destText, `${ts.name} · ${fmtDistance(stationDistance(st, ts))}`);
      destText.className = 'tls-ion';
    } else if (t && t.kind === 'body') {
      put(destText, g.model.body(t.id).name);
      destText.className = 'tls-ion';
    } else {
      put(destText, 'None set — choose one under Departures');
      destText.className = 'tls-dimtxt';
    }
    launch.update({ detail: fmtSpeed(f.deltaV) });
  }

  // ---- market
  function marketView(): HTMLElement[] {
    const g = host.game;
    const p = g.player();
    const held = new Map(p.cargo.map((c) => [c.commodityId, c]));
    let rows = g.market().slice();
    if (filter === 'hold') rows = rows.filter((r) => held.has(r.commodityId));
    if (filter === 'cheap') rows = rows.filter((r) => r.stock >= 1).sort((a, b) => a.buyPrice / a.avgPrice - b.buyPrice / b.avgPrice);
    else rows.sort((a, b) => Number(held.has(b.commodityId)) - Number(held.has(a.commodityId)) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    const seg = SegmentedControl<Filter>({
      items: [{ id: 'all', label: 'All goods' }, { id: 'cheap', label: 'Cheap here' }, { id: 'hold', label: `In hold${p.cargo.length ? ` · ${p.cargoUsed}` : ''}` }],
      value: filter, block: true, onChange: (v) => { filter = v; render(true); },
    });
    const out: HTMLElement[] = [
      h('div.tls-filter', null, seg.el),
      h('div.tls-mhead', null, h('span'), h('span', { text: 'Commodity · vs galactic avg' }), h('span', { text: 'Buy' }), h('span', { text: 'Sell' })),
    ];
    if (!rows.length) {
      out.push(EmptyState({ icon: 'cargo', title: filter === 'hold' ? 'The hold is empty' : 'Nothing on the board', message: filter === 'hold' ? 'Buy what is cheap here and carry it to where it is dear.' : undefined }).el);
      return out;
    }
    for (const r of rows) {
      const c = held.get(r.commodityId);
      const row = h('button.tls-mrow', { class: c && 'tls-mrow--held', attrs: { type: 'button' } },
        h('span.tls-mrow__ico', null, icon(catIcon(r.category), 20)),
        h('span', null,
          h('div.tls-mrow__name', { text: r.name }),
          c ? h('div.tls-mrow__sub.tls-ember', { text: `${fmtInt(c.units)} t aboard · paid ${fmtInt(c.avgPaid)}` })
            : h('div.tls-mrow__sub', { text: `${cap(r.category)} · ${r.stock >= 1 ? `stock ${fmtInt(r.stock)} t` : 'none in stock'}${r.legal ? '' : ' · contraband'}` })),
        h('span', null, h('div.tls-mrow__p.tl-num', { text: r.stock >= 1 ? fmtInt(r.buyPrice) : '—' }),
          h('div.tls-mrow__d', null, r.stock >= 1 ? delta(r.buyPrice / r.avgPrice - 1, { invert: true, format: (a) => `${Math.round(a * 100)}%` }) : null)),
        h('span', null, h('div.tls-mrow__p.tl-num', { text: fmtInt(r.sellPrice) }),
          h('div.tls-mrow__d', null, c
            ? h('span.tl-num', { class: r.sellPrice >= c.avgPaid ? 'tls-good' : 'tls-bad', text: `${r.sellPrice >= c.avgPaid ? '+' : '−'}${fmtInt(Math.abs(r.sellPrice - c.avgPaid))} /t` })
            : delta(r.sellPrice / r.avgPrice - 1, { format: (a) => `${Math.round(a * 100)}%` }))),
      );
      onTap(row, () => openTrade(r.commodityId, c && (filter === 'hold' || r.stock < 1) ? 'sell' : 'buy'));
      out.push(row);
    }
    return out;
  }

  // ---- trade sheet
  function openTrade(id: string, mode: 'buy' | 'sell'): void {
    const first = host.game.market().find((r) => r.commodityId === id);
    const st = host.game.dockedStation();
    if (!first || !st) return;
    let qty = 1;
    let max = 0;
    const seg = SegmentedControl<'buy' | 'sell'>({ items: [{ id: 'buy', label: 'Buy' }, { id: 'sell', label: 'Sell' }], value: mode, block: true, onChange: (m) => { mode = m; qty = 1; sync(); } });
    const stepper = Stepper({ value: 1, min: 0, max: 1, unit: 't', block: true, ariaLabel: 'Quantity', onChange: (v) => { qty = v; sync(); } });
    const maxBtn = Button({ label: 'Max', variant: 'secondary', onTap: () => { qty = max; sync(); } });
    const facts = h('div');
    const totalK = h('span.tl-label');
    const totalV = h('b.tl-num');
    const avg = h('div.tls-trade-note.tls-dimtxt');
    const note = h('div.tls-trade-note');
    const go = Button({ label: 'Buy', variant: 'primary', size: 'lg', block: true, onTap: commit });

    function sync(): void {
      const g = host.game;
      const r: MarketRow | undefined = g.market().find((x) => x.commodityId === id);
      if (!r) return;
      const p = g.player();
      const c = p.cargo.find((x) => x.commodityId === id);
      const buying = mode === 'buy';
      max = Math.floor((buying ? g.quoteBuy(id, 100000) : g.quoteSell(id, 100000)).units);
      qty = Math.max(max > 0 ? 1 : 0, Math.min(Math.round(qty), max));
      const q = qty > 0 ? (buying ? g.quoteBuy(id, qty) : g.quoteSell(id, qty)) : null;
      stepper.update({ min: max > 0 ? 1 : 0, max, value: qty });
      maxBtn.update({ disabled: max <= 0 || qty >= max });
      facts.replaceChildren(KeyValue({
        cols: 3,
        items: [
          { k: buying ? 'Price here' : 'They pay', v: fmtInt(buying ? r.buyPrice : r.sellPrice), unit: 'cr/t' },
          { k: 'Galactic avg', v: fmtInt(r.avgPrice), unit: 'cr/t' },
          buying ? { k: 'In stock', v: fmtInt(r.stock), unit: 't' } : { k: 'Aboard', v: fmtInt(c?.units ?? 0), unit: 't' },
        ],
      }).el);
      put(totalK, buying ? 'Total cost' : 'You receive');
      put(totalV, q ? fmtCredits(q.total) : '—');
      put(avg, q && q.units > 1 ? `Average ${fmtInt(q.average)} cr/t over ${fmtInt(q.units)} t — the price moves as you trade.` : buying && c ? `You hold ${fmtInt(c.units)} t, bought at ${fmtInt(c.avgPaid)} cr/t.` : '');
      // Why not, or why not more.
      let msg = '';
      let cls = 'tls-dimtxt';
      if (buying) {
        const free = p.cargoCapacity - p.cargoUsed;
        if (max <= 0) {
          cls = 'tls-bad';
          msg = free < 1 ? 'The hold is full. Sell something first.' : r.stock < 1 ? 'The station has none to sell.' : p.credits < r.buyPrice ? `Not enough credits: one tonne costs ${fmtCredits(r.buyPrice)} and you have ${fmtCredits(p.credits)}.` : 'This is not for sale to you here.';
        } else {
          msg = `Up to ${fmtInt(max)} t — limited by ${max >= free ? 'hold space' : max >= Math.floor(r.stock) ? 'the station’s stock' : 'your credits'}.`;
          if (q) msg += ` Leaves ${fmtCredits(p.credits - q.total)}.`;
        }
      } else if (!c || c.units < 1) {
        cls = 'tls-bad';
        msg = 'You have none aboard to sell.';
      } else if (max <= 0) {
        cls = 'tls-bad';
        msg = 'The station is not buying this.';
      } else if (q) {
        const profit = q.total - c.avgPaid * q.units;
        cls = profit >= 0 ? 'tls-good' : 'tls-bad';
        msg = `${profit >= 0 ? 'Profit' : 'Loss'} ${profit >= 0 ? '+' : '−'}${fmtCredits(Math.abs(profit))} against the ${fmtInt(c.avgPaid)} cr/t you paid.`;
        if (max < c.units) msg += ` The station will take only ${fmtInt(max)} t.`;
      }
      if (!r.legal) msg += ' Contraband under this station’s law.';
      put(note, msg);
      note.className = `tls-trade-note ${cls}`;
      go.update({ label: `${buying ? 'Buy' : 'Sell'} ${fmtInt(qty)} t`, detail: q ? fmtCredits(q.total) : '', disabled: !q });
    }

    function commit(): void {
      const g = host.game;
      if (qty <= 0) return;
      const buying = mode === 'buy';
      const q = buying ? g.quoteBuy(id, qty) : g.quoteSell(id, qty);
      const r = buying ? g.buy(id, qty) : g.sell(id, qty);
      if (!r.ok) {
        host.toast(r.reason, 'bad');
        return sync();
      }
      host.sfx('trade');
      host.toast(`${buying ? 'Bought' : 'Sold'} ${fmtInt(q.units)} t of ${first!.name} for ${fmtCredits(q.total)}.`, 'good');
      bs.close();
      sig = '';
    }

    const bs = BottomSheet({
      title: first.name, eyebrow: `${cap(first.category)} · ${st.name}`,
      body: [seg.el, facts, h('div.tls-qty', null, stepper.el, maxBtn.el), h('div.tls-trade-total', null, totalK, totalV), avg, note],
      footer: go.el,
      onClose: () => { sheet = null; },
    });
    sheet = { close: () => bs.close(), sync };
    sync();
    bs.open(el);
  }

  // ---- ship
  function shipView(): HTMLElement[] {
    const g = host.game;
    const p = g.player();
    const f = g.flightInfo();
    const out: HTMLElement[] = [];
    const hullPanel = Panel({ title: `${p.shipName} · hull`, icon: 'hull', solid: true });
    const rq = g.repairQuote();
    hullPanel.body.append(h('div.tls-sec', null,
      h('div.tls-bar-row', null, h('span.tl-label', { text: 'Integrity' }), h('b.tl-num', { class: f.hullFraction < 0.5 ? 'tls-bad' : '', text: fmtPercent(f.hullFraction, 0) })),
      ProgressBar({ value: f.hullFraction, tone: f.hullFraction < 0.5 ? 'red' : 'green' }).el,
      Button({
        label: rq.cost > 0 ? 'Repair hull' : 'Hull is sound', icon: 'repair', detail: rq.cost > 0 ? fmtCredits(rq.cost) : undefined, block: true, disabled: rq.cost <= 0,
        onTap: () => {
          const r = g.repair();
          host.toast(r.ok ? 'Hull repaired.' : r.reason, r.ok ? 'good' : 'bad');
          sig = '';
        },
      }).el));
    out.push(hullPanel.el);

    const fuelPanel = Panel({ title: 'Propellant', icon: 'fuel', solid: true });
    const q = g.refuelQuote();
    const afford = q.pricePerKg > 0 ? Math.floor(p.credits / q.pricePerKg) : q.kg;
    const maxKg = Math.max(0, Math.min(Math.floor(q.kg), afford));
    const sec = h('div.tls-sec', null,
      h('div.tls-bar-row', null, h('span.tl-label', { text: `${fmtMass(f.propellant)} of ${fmtMass(f.propellantCapacity)}` }), h('b.tl-num', { text: `Δv ${fmtSpeed(f.deltaV)}` })),
      ProgressBar({ value: f.propellantFraction, tone: f.propellantFraction < LOW_FRACTION ? 'red' : 'ion' }).el);
    if (q.kg < 1) sec.append(h('p.tl-small', { text: 'Tanks are full.' }));
    else if (maxKg < 1) sec.append(h('p.tl-small.tls-bad', { text: `Not enough credits for propellant (${fmtCredits(q.cost)} to fill).` }));
    else {
      const step = Math.max(1, Math.round(maxKg / 100));
      let kg = maxKg;
      const btn = Button({
        label: 'Refuel', icon: 'refuel', variant: 'ion', block: true, detail: fmtCredits(Math.ceil(kg * q.pricePerKg)),
        onTap: () => {
          const full = kg >= maxKg - step;
          const r = full && maxKg >= Math.floor(q.kg) ? g.refuel() : g.refuel(full ? maxKg : kg);
          host.toast(r.ok ? `Took on ${fmtMass(full ? maxKg : kg)} of propellant.` : r.reason, r.ok ? 'good' : 'bad');
          if (r.ok) host.sfx('refuel');
          sig = '';
        },
      });
      const sl = Slider({
        label: maxKg < Math.floor(q.kg) ? 'Take on (what your credits cover)' : 'Take on', value: maxKg, min: 0, max: maxKg, step, tone: 'ion', ticks: 10,
        format: (v) => (v >= maxKg - step ? `${fmtMass(maxKg)} · full` : fmtMass(v)),
        onInput: (v) => { kg = v; btn.update({ detail: fmtCredits(Math.ceil((v >= maxKg - step ? maxKg : v) * q.pricePerKg)), disabled: v < 1 }); },
      });
      sec.append(sl.el, btn.el);
    }
    fuelPanel.body.append(sec);
    out.push(fuelPanel.el);

    const hold = Panel({ title: `Cargo · ${fmtInt(p.cargoUsed)} / ${fmtInt(p.cargoCapacity)} t`, icon: 'cargo', solid: true, flush: p.cargo.length > 0 });
    if (!p.cargo.length) hold.body.append(h('p.tl-small', { text: 'The hold is empty. The market board shows what is cheap here.' }));
    else {
      const here = new Map(g.market().map((r) => [r.commodityId, r]));
      for (const c of p.cargo) {
        const r = here.get(c.commodityId);
        const row = h('button.tls-mrow', { attrs: { type: 'button' }, style: 'grid-template-columns: 34px minmax(0,1fr) 66px 66px; padding: 0 12px;' },
          h('span.tls-mrow__ico', null, icon(r ? catIcon(r.category) : 'cargo', 20)),
          h('span', null, h('div.tls-mrow__name', { text: c.name }), h('div.tls-mrow__sub', { text: `${fmtInt(c.units)} t · paid ${fmtInt(c.avgPaid)} cr/t` })),
          h('span', null, h('div.tls-mrow__p.tl-num', { text: r ? fmtInt(r.sellPrice) : '—' }), h('div.tls-mrow__d', { text: 'sells here' })),
          h('span', null, h('div.tls-mrow__p.tl-num', { class: r && r.sellPrice >= c.avgPaid ? 'tls-good' : 'tls-bad', text: r ? `${r.sellPrice >= c.avgPaid ? '+' : '−'}${fmtInt(Math.abs(r.sellPrice - c.avgPaid) * c.units)}` : '' }), h('div.tls-mrow__d', { text: 'if sold' })));
        if (r) onTap(row, () => openTrade(c.commodityId, 'sell'));
        hold.body.append(row);
      }
    }
    out.push(hold.el);
    out.push(KeyValue({ cols: 3, items: [{ k: 'Mass', v: fmtMass(f.mass) }, { k: 'Thrust', v: f.maxAccel.toFixed(1), unit: 'm/s²' }, { k: 'Net worth', v: fmtCredits(p.netWorth, true) }] }).el);
    return [h('div.tls-pad-x', { style: 'display:flex;flex-direction:column;gap:12px;padding-top:12px;padding-bottom:12px;' }, out)];
  }

  // ---- departures
  function departuresView(st: StationDef): HTMLElement[] {
    const g = host.game;
    const t = g.target();
    const about = Panel({ title: st.name, icon: 'station', solid: true },
      h('p.tl-body', { text: st.description }),
      h('p.tl-small', { text: `${fmtInt(st.population)} aboard · ${st.economies.map(cap).join(', ')} economy` }));
    const others = g.system.stations.filter((s) => s.id !== st.id).map((s) => ({ s, d: stationDistance(st, s) })).sort((a, b) => a.d - b.d);
    const cards = others.map(({ s, d }) => {
      const isTarget = !!t && t.kind === 'station' && t.id === s.id;
      const near = s.parentBodyId === st.parentBodyId;
      const parent = g.model.body(s.parentBodyId);
      return h('div.tls-dep', { class: isTarget && 'tls-dep--target' },
        h('div.tls-dep__top', null, h('span.tls-dep__name', { text: s.name }), h('span.tls-dep__dist.tl-num', { text: fmtDistance(d) })),
        h('div.tl-row.tl-row--wrap', null,
          Badge({ label: stationKindLabel(s.visualId), tone: 'neutral' }).el,
          Badge({ label: near ? `Same world · ${fmtDistance(s.orbit.a - parent.radius)} orbit` : `Orbits ${parent.name}`, tone: near ? 'ion' : 'dim' }).el,
          near ? null : Badge({ label: 'Long haul', tone: 'ember', icon: 'warning' }).el),
        h('p.tl-small', { text: firstSentence(s.description) }),
        isTarget
          ? Button({ label: 'Destination set', icon: 'check', variant: 'ghost', block: true, onTap: () => { g.setTarget(null); sig = ''; } }).el
          : Button({ label: 'Set as destination', icon: 'target', variant: near ? 'ion' : 'secondary', block: true, onTap: () => {
            const r = g.setTarget({ kind: 'station', id: s.id });
            host.toast(r.ok ? `Destination: ${s.name}.` : r.reason, r.ok ? 'info' : 'bad');
            sig = '';
          } }).el);
    });
    return [h('div.tls-pad-x', { style: 'display:flex;flex-direction:column;gap:12px;padding-top:12px;padding-bottom:12px;' },
      h('div.tl-label', { text: 'Stations in the Tallow system' }), cards, about.el)];
  }

  function render(resetScroll = false): void {
    const st = host.game.dockedStation();
    if (!st) return;
    const top = resetScroll ? 0 : screen.body.scrollTop;
    screen.body.style.gap = '0';
    screen.body.replaceChildren(...(tab === 'market' ? marketView() : tab === 'ship' ? shipView() : departuresView(st)));
    screen.body.scrollTop = top;
    refreshChrome(st);
    sheet?.sync();
  }

  function signature(): string {
    const g = host.game;
    const p = g.player();
    const f = g.flightInfo();
    const t = g.target();
    return [g.state === undefined ? 0 : 1, g.dockedStation()?.id, p.credits, p.cargoUsed, p.cargo.length, Math.round(f.propellant), f.hullFraction.toFixed(3), t ? t.id : '', Math.floor(g.time() / DAY)].join('|');
  }
  let lastGame: unknown = null;

  return {
    el,
    show() {
      el.hidden = false;
      sig = '';
      poll = 0;
      this.update(0);
    },
    hide() {
      el.hidden = true;
      sheet?.close();
      pause?.hide();
    },
    update(dt: number) {
      poll -= dt;
      if (sig !== '' && poll > 0 && lastGame === host.game) return;
      poll = 0.4;
      const st = host.game.dockedStation();
      if (!st) return;
      const s = signature();
      if (s !== sig || lastGame !== host.game) {
        sig = s;
        lastGame = host.game;
        render();
      } else refreshChrome(st);
    },
    dispose() {
      sheet?.close();
      pause?.dispose();
      screen.destroy();
      el.remove();
    },
  };
}
