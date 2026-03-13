/**
 * ═══════════════════════════════════════════════════════════════
 * FLEETSOURCE SPOTTER IQ — v3.9 LIVE
 * Geotab Add-in: geotab.addin.spotterIQ
 *
 * LIVE DATA VERSION — No hardcoded sample data.
 * All telemetry fetched from Geotab API via multiCall.
 *
 * Five Operational States:
 *   MOVING        Green    RPM>400 · Spd>1 · Jaw:1
 *   BOBTAILING    Yellow   RPM>400 · Spd>1 · Jaw:0
 *   COUPLED_IDLE  Orange   RPM>400 · Spd<1 · Jaw:1
 *   BOBTAIL_IDLE  Red      RPM>400 · Spd<1 · Jaw:0
 *   OFF           Dark     RPM<400
 * ═══════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    // ══════════════════════════════════════════════════════════
    //  CONSTANTS
    // ══════════════════════════════════════════════════════════

    var STATES = {
        MOVING:       { key: 'MOVING',       label: 'Moving',       css: 'moving',       color: '#16a34a', tip: 'Engine On, Speed > 1 mph, Trailer Coupled.' },
        BOBTAILING:   { key: 'BOBTAILING',   label: 'Bobtailing',   css: 'bobtailing',   color: '#ca8a04', tip: 'Engine On, Speed > 1 mph, No Trailer detected.' },
        COUPLED_IDLE: { key: 'COUPLED_IDLE', label: 'Coupled Idle', css: 'coupled-idle', color: '#ea580c', tip: 'Engine On, Speed < 1 mph, Trailer Coupled.' },
        BOBTAIL_IDLE: { key: 'BOBTAIL_IDLE', label: 'Bobtail Idle', css: 'bobtail-idle', color: '#dc2626', tip: 'Engine On, Speed < 1 mph, No Trailer detected.' },
        OFF:          { key: 'OFF',          label: 'Off',          css: 'off',          color: '#374151', tip: 'Engine Off (RPM < 400).' }
    };
    var STATE_ORDER = ['MOVING', 'BOBTAILING', 'COUPLED_IDLE', 'BOBTAIL_IDLE', 'OFF'];
    var SLOT_LABELS = ['4–8 AM', '8 AM–12 PM', '12–4 PM', '4–8 PM', '8 PM–12 AM', '12–4 AM'];
    var SLOT_HOURS  = [[4,8],[8,12],[12,16],[16,20],[20,24],[0,4]];

    var DIAG = {
        AUX1:          'DiagnosticAuxiliary1Id',
        SPEED:         'DiagnosticVehicleSpeedId',
        RPM:           'DiagnosticEngineSpeedId',
        FUEL_USED:     'DiagnosticTotalFuelUsedId',
        ENGINE_HOURS:  'DiagnosticEngineHoursId',
        FUEL_LEVEL:    'DiagnosticFuelLevelId',
        DEF_LEVEL:     'DiagnosticDieselExhaustFluidId'
    };

    var KPH_TO_MPH   = 0.621371;
    var LITERS_TO_GAL = 0.264172;
    var OP_DAY_START  = 4; // 4:00 AM

    // ══════════════════════════════════════════════════════════
    //  CACHED STATE
    // ══════════════════════════════════════════════════════════

    var geotabApi    = null;   // set on initialize
    var geotabState  = null;   // Geotab state object (group filter, etc.)
    var cachedDevices = [];    // Device objects from API (filtered by group)
    var sensorMap    = {};     // deviceId → true/false (has jaw sensor)
    var lastSeenMap  = {};     // deviceId → Date (from DeviceStatusInfo)
    var fleetCache   = null;   // cached fleet summary
    var dayCache     = {};     // 'deviceId-dayIdx' → day data

    // ══════════════════════════════════════════════════════════
    //  TOOLTIP SYSTEM
    // ══════════════════════════════════════════════════════════

    var tooltipEl = null;

    function initTooltip() {
        tooltipEl = document.getElementById('tooltip');
    }

    function attachTip(elem, text) {
        elem.addEventListener('mouseenter', function () {
            var rect = elem.getBoundingClientRect();
            tooltipEl.textContent = text;
            tooltipEl.classList.add('tooltip--visible');
            var tipRect = tooltipEl.getBoundingClientRect();
            var tipW = tipRect.width;
            var left = rect.left + rect.width / 2 - tipW / 2;
            var top = rect.top - 6;
            if (left < 8) left = 8;
            if (left + tipW > window.innerWidth - 8) left = window.innerWidth - 8 - tipW;
            tooltipEl.style.left = left + 'px';
            tooltipEl.style.top = top + 'px';
            tooltipEl.style.transform = 'translateY(-100%)';
        });
        elem.addEventListener('mouseleave', function () {
            tooltipEl.classList.remove('tooltip--visible');
        });
    }

    function wireTips(container) {
        var items = container.querySelectorAll('[data-tip]');
        for (var i = 0; i < items.length; i++) {
            attachTip(items[i], items[i].getAttribute('data-tip'));
        }
    }

    // ══════════════════════════════════════════════════════════
    //  HTML HELPERS  (identical to demo)
    // ══════════════════════════════════════════════════════════

    function el(tag, cls, html) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html !== undefined) e.innerHTML = html;
        return e;
    }

    function gphClass(v)  { return v < 2.0 ? 'green' : v <= 3.0 ? 'amber' : 'red'; }
    function gphColor(v)  { return v < 2.0 ? '#16a34a' : v <= 3.0 ? '#ca8a04' : '#dc2626'; }
    function gphBg(v)     { return v < 2.0 ? 'rgba(22,163,74,0.07)' : v <= 3.0 ? 'rgba(202,138,4,0.07)' : 'rgba(220,38,38,0.07)'; }
    function gphTag(v)    { return v < 2.0 ? 'EFFICIENT' : v <= 3.0 ? 'MONITOR' : 'OVER LIMIT'; }

    function sensorBadgeHTML(ok) {
        if (ok) {
            return '<span class="badge-sensor badge-sensor--jaw" data-tip="IOX-AUXM Jaw Proximity Sensor reporting. Full five-state classification available.">' +
                   '<span class="badge-sensor__dot"></span>JAW SENSOR</span>';
        }
        return '<span class="badge-sensor badge-sensor--rpm" data-tip="No IOX-AUXM detected. Running on engine RPM data only. Cannot distinguish coupled vs. bobtail states.">' +
               '<span class="badge-sensor__dot"></span>RPM ONLY</span>';
    }

    function stateBadgeHTML(stateKey, isFallback, isOffline, checkSensor) {
        if (isOffline) {
            return '<span class="badge-state badge-state--offline" data-tip="No device communication for 7+ days. Check GO9 power connection or confirm asset is in storage.">' +
                   '<span class="badge-state__dot"></span>OFFLINE</span>';
        }
        if (checkSensor) {
            return '<span class="badge-state badge-state--check-sensor" data-tip="Ignition ON >2 hours, exceeded 10 mph 5+ times, but jaw sensor stuck at 0. Possible IOX-AUXM failure.">' +
                   '<span class="badge-state__dot"></span>CHECK SENSOR</span>';
        }
        if (isFallback) {
            var isOn = stateKey !== 'OFF';
            var cls = isOn ? 'badge-state--fallback-on' : 'badge-state--fallback-off';
            var lbl = isOn ? 'Engine On' : 'Off';
            var tip = isOn ? 'Engine running (RPM > 400). No jaw sensor — cannot determine trailer coupling state.' : 'Engine Off (RPM < 400).';
            return '<span class="badge-state ' + cls + '" data-tip="' + tip + '"><span class="badge-state__dot"></span>' + lbl + '</span>';
        }
        var st = STATES[stateKey];
        return '<span class="badge-state badge-state--' + st.css + '" data-tip="' + st.tip + '"><span class="badge-state__dot"></span>' + st.label + '</span>';
    }

    function buildLegend(container, showFallback) {
        container.innerHTML = '';
        STATE_ORDER.forEach(function (k) {
            var st = STATES[k];
            var item = el('span', 'legend__item');
            item.innerHTML = '<span class="legend__swatch" style="background:' + st.color + '"></span>' +
                             '<span style="color:' + st.color + ';font-weight:700">' + st.label + '</span>';
            item.setAttribute('data-tip', st.tip);
            container.appendChild(item);
        });
        if (showFallback) {
            var fb = el('span', 'legend__fallback');
            fb.innerHTML = '<span class="legend__hatch-swatch"></span>' +
                           '<span style="color:#ca8a04;font-weight:700">RPM Only Fallback</span>';
            fb.setAttribute('data-tip', 'No IOX-AUXM jaw sensor detected. Engine Hours and Fuel data are valid, but coupled/bobtail split is unavailable.');
            container.appendChild(fb);
        }
        wireTips(container);
    }

    function loadingRow(cols, msg) {
        return '<tr><td colspan="' + cols + '" style="text-align:center;color:#9ca3af;padding:40px;font-size:13px">' + (msg || 'Loading fleet data…') + '</td></tr>';
    }

    // ══════════════════════════════════════════════════════════
    //  FIVE-STATE CLASSIFIER
    // ══════════════════════════════════════════════════════════

    function classifyState(rpm, speedMph, jawLocked) {
        if (rpm < 400) return 'OFF';
        if (jawLocked === null) return 'BOBTAIL_IDLE';
        if (speedMph > 1 && jawLocked === 1) return 'MOVING';
        if (speedMph > 1 && jawLocked === 0) return 'BOBTAILING';
        if (speedMph <= 1 && jawLocked === 1) return 'COUPLED_IDLE';
        return 'BOBTAIL_IDLE';
    }

    // ══════════════════════════════════════════════════════════
    //  API HELPERS
    // ══════════════════════════════════════════════════════════

    /** Safe multiCall with sequential fallback */
    async function multi(api, calls) {
        if (!calls.length) return [];
        try {
            return await api.multiCall(calls);
        } catch (e) {
            console.warn('multiCall failed, falling back to sequential:', e);
            var results = [];
            for (var i = 0; i < calls.length; i++) {
                try { results.push(await api.call(calls[i][0], calls[i][1])); }
                catch (err) { results.push([]); }
            }
            return results;
        }
    }

    /** StatusData search shorthand */
    function sdSearch(deviceId, diagId, from, to, limit) {
        var params = {
            typeName: 'StatusData',
            search: {
                deviceSearch: { id: deviceId },
                diagnosticSearch: { id: diagId },
                fromDate: from,
                toDate: to
            }
        };
        if (limit) params.resultsLimit = limit;
        return ['Get', params];
    }

    /** Get last element of an array safely */
    function last(arr) { return arr && arr.length ? arr[arr.length - 1] : null; }

    /** Calculate shift fromDate */
    function shiftFrom(opt) {
        var d = new Date();
        if (opt === 12) { d.setHours(d.getHours() - 12); }
        else { d.setHours(opt, 0, 0, 0); if (d > new Date()) d.setDate(d.getDate() - 1); }
        return d.toISOString();
    }

    /** Get operational day boundaries. dayOffset: 0=today, 1=yesterday, etc. */
    function opDayBounds(dayOffset) {
        var now = new Date();
        var start = new Date(now);
        start.setHours(OP_DAY_START, 0, 0, 0);
        if (now.getHours() < OP_DAY_START) start.setDate(start.getDate() - 1);
        start.setDate(start.getDate() - dayOffset);
        var end = new Date(start);
        end.setDate(end.getDate() + 1);
        return { start: start, end: end, startISO: start.toISOString(), endISO: end.toISOString() };
    }

    /** Format date for display */
    function fmtDay(d) {
        return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }

    // ══════════════════════════════════════════════════════════
    //  INITIALIZATION: Load devices + detect sensors
    // ══════════════════════════════════════════════════════════

    async function loadDevices(api, state) {
        // Get selected group(s) from Geotab's group filter dropdown
        var groupFilter = [];
        try {
            groupFilter = state.getGroupFilter();
        } catch (e) {
            console.warn('getGroupFilter not available:', e);
        }

        // Build device search — if groups are selected, filter by them
        var deviceSearch = { typeName: 'Device' };
        if (groupFilter && groupFilter.length > 0) {
            deviceSearch.search = {
                groups: groupFilter.map(function (g) { return { id: g.id || g }; })
            };
        }

        cachedDevices = await api.call('Get', deviceSearch);
        console.log('Loaded ' + cachedDevices.length + ' devices' +
            (groupFilter.length ? ' (filtered by ' + groupFilter.length + ' group(s))' : ' (no group filter)'));
        if (!cachedDevices.length) return;

        // Fetch DeviceStatusInfo for real lastCommunicateDate
        // This is the ONLY reliable source for "last seen" — the Device object does NOT have it
        try {
            var statusInfos = await api.call('Get', { typeName: 'DeviceStatusInfo' });
            var statusMap = {};
            statusInfos.forEach(function (si) {
                statusMap[si.device ? si.device.id : ''] = si;
            });
            cachedDevices.forEach(function (d) {
                var si = statusMap[d.id];
                if (si && si.dateTime) {
                    lastSeenMap[d.id] = new Date(si.dateTime);
                } else if (si && si.lastCommunicateDate) {
                    lastSeenMap[d.id] = new Date(si.lastCommunicateDate);
                } else {
                    lastSeenMap[d.id] = null;
                }
            });
            console.log('DeviceStatusInfo loaded for ' + Object.keys(lastSeenMap).length + ' devices');
        } catch (e) {
            console.warn('DeviceStatusInfo fetch failed, falling back:', e);
            // Fallback: try reading from device object properties
            cachedDevices.forEach(function (d) {
                lastSeenMap[d.id] = d.lastCommunicateDate ? new Date(d.lastCommunicateDate) : null;
            });
        }

        // Detect jaw sensors: check for ANY Aux1 data in last 7 days
        var now = new Date().toISOString();
        var weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
        var calls = cachedDevices.map(function (d) {
            return sdSearch(d.id, DIAG.AUX1, weekAgo, now, 1);
        });
        var results = await multi(api, calls);
        cachedDevices.forEach(function (d, i) {
            sensorMap[d.id] = !!(results[i] && results[i].length > 0);
        });
    }

    // ══════════════════════════════════════════════════════════
    //  LEAF GROUP RESOLVER
    // ══════════════════════════════════════════════════════════

    async function resolveLeafGroup(api, state) {
        try {
            // Read the user's selected group(s) from Geotab's group filter
            var groupFilter = [];
            try { groupFilter = state.getGroupFilter(); } catch (e) { /* no-op */ }

            if (!groupFilter || !groupFilter.length) return 'Fleet';

            // Fetch group details to get the display name
            var groups = await api.call('Get', { typeName: 'Group' });
            var groupMap = {};
            groups.forEach(function (g) { groupMap[g.id] = g; });

            // Use the first selected group's name (the one the user picked in the dropdown)
            // Walk from the selected group(s) to find the most specific (deepest) one
            var bestName = 'Fleet';
            var bestDepth = -1;
            groupFilter.forEach(function (gf) {
                var gid = gf.id || gf;
                var g = groupMap[gid];
                if (!g) return;

                // Calculate depth
                var depth = 0;
                var cur = g;
                while (cur && cur.parent && groupMap[cur.parent.id]) {
                    depth++;
                    cur = groupMap[cur.parent.id];
                }
                if (depth > bestDepth) {
                    bestDepth = depth;
                    bestName = g.name;
                }
            });

            return bestName;
        } catch (e) {
            console.warn('Leaf group resolution failed:', e);
            return 'Fleet';
        }
    }

    // ══════════════════════════════════════════════════════════
    //  LIVE DATA FETCH
    // ══════════════════════════════════════════════════════════

    async function fetchLiveData(api, shiftHrs) {
        var now = new Date();
        var nowISO = now.toISOString();
        var fromISO = shiftFrom(shiftHrs);
        var rows = [];

        // Separate offline vs online devices using DeviceStatusInfo dates
        var onlineDevices = [];
        cachedDevices.forEach(function (d) {
            var lastSeen = lastSeenMap[d.id] || null;
            var daysOff = lastSeen ? (now - lastSeen) / 864e5 : 999;
            if (daysOff > 7) {
                rows.push({
                    truck: { id: d.id, name: d.name, sensorOk: !!sensorMap[d.id] },
                    stateKey: 'OFF', moves: '--', lastSeen: lastSeen || new Date(0),
                    fuelPct: '--', defPct: '--', engineHrs: '--',
                    isOffline: true, checkSensor: false
                });
            } else {
                onlineDevices.push(d);
            }
        });

        if (!onlineDevices.length) return rows;

        // Build multicall: 6 queries per online device
        var calls = [];
        onlineDevices.forEach(function (d) {
            calls.push(sdSearch(d.id, DIAG.AUX1,       fromISO, nowISO));       // 0: jaw (full window)
            calls.push(sdSearch(d.id, DIAG.SPEED,       fromISO, nowISO));       // 1: speed (full window)
            calls.push(sdSearch(d.id, DIAG.RPM,         fromISO, nowISO));       // 2: RPM (full window)
            calls.push(sdSearch(d.id, DIAG.FUEL_LEVEL,  fromISO, nowISO));       // 3: fuel level
            calls.push(sdSearch(d.id, DIAG.DEF_LEVEL,   fromISO, nowISO));       // 4: DEF level
            calls.push(sdSearch(d.id, DIAG.ENGINE_HOURS, fromISO, nowISO));        // 5: engine hours
        });

        var results = await multi(api, calls);

        // Process 6 results per device
        onlineDevices.forEach(function (d, i) {
            var base = i * 6;
            var jawData   = results[base]     || [];
            var speedData = results[base + 1] || [];
            var rpmData   = results[base + 2] || [];
            var fuelData  = results[base + 3] || [];
            var defData   = results[base + 4] || [];
            var engData   = results[base + 5] || [];

            var hasSensor = sensorMap[d.id];
            var lastSeen = lastSeenMap[d.id] || new Date();

            // ── Current state ──
            var latestRpm   = last(rpmData)   ? rpmData[rpmData.length - 1].data : 0;
            var latestSpeed = last(speedData)  ? speedData[speedData.length - 1].data * KPH_TO_MPH : 0;
            var latestJaw   = hasSensor && last(jawData) ? jawData[jawData.length - 1].data : null;
            var stateKey    = classifyState(latestRpm, latestSpeed, latestJaw);

            // ── Completed moves: count jaw 0→1 transitions with speed > 2 mph ──
            var moves = 0;
            if (hasSensor && jawData.length > 1) {
                var prevJaw = jawData[0].data;
                for (var j = 1; j < jawData.length; j++) {
                    if (jawData[j].data === 1 && prevJaw === 0) {
                        // Rising edge — check if speed > 3.22 km/h (2 mph) while jaw stays locked
                        var lockTime = new Date(jawData[j].dateTime).getTime();
                        var unlockTime = lockTime + 600000; // default 10 min window
                        for (var jj = j + 1; jj < jawData.length; jj++) {
                            if (jawData[jj].data === 0) { unlockTime = new Date(jawData[jj].dateTime).getTime(); break; }
                        }
                        for (var s = 0; s < speedData.length; s++) {
                            var st = new Date(speedData[s].dateTime).getTime();
                            if (st >= lockTime && st <= unlockTime && speedData[s].data > 3.22) {
                                moves++;
                                break;
                            }
                        }
                    }
                    prevJaw = jawData[j].data;
                }
            } else if (!hasSensor) {
                // RPM fallback: estimate moves from distinct speed bursts > 2 mph
                var inBurst = false;
                for (var ss = 0; ss < speedData.length; ss++) {
                    if (speedData[ss].data > 3.22 && !inBurst) { moves++; inBurst = true; }
                    else if (speedData[ss].data <= 1.6) { inBurst = false; }
                }
            }

            // ── Check Sensor alert ──
            var checkSensor = false;
            if (hasSensor && jawData.length > 0) {
                // Ignition on hours: span of RPM > 400
                var onRpm = rpmData.filter(function (r) { return r.data > 400; });
                var ignHrs = 0;
                if (onRpm.length > 1) {
                    ignHrs = (new Date(onRpm[onRpm.length - 1].dateTime) - new Date(onRpm[0].dateTime)) / 36e5;
                }
                // High speed event count (distinct bursts > 10 mph / 16.09 km/h)
                var highCount = 0;
                var wasHigh = false;
                speedData.forEach(function (sp) {
                    if (sp.data > 16.09 && !wasHigh) { highCount++; wasHigh = true; }
                    else if (sp.data <= 16.09) { wasHigh = false; }
                });
                // Jaw always zero
                var jawAlwaysZero = jawData.every(function (jd) { return jd.data === 0; });
                checkSensor = ignHrs > 2 && highCount >= 5 && jawAlwaysZero;
            }

            // ── Fuel / DEF / Engine Hours ──
            var latestFuel = last(fuelData);
            var latestDef  = last(defData);
            var latestEng  = last(engData);
            var fuelPct = latestFuel ? Math.round(latestFuel.data) + '%' : '--';
            var defPct  = latestDef  ? Math.round(latestDef.data)  + '%' : '--';
            var engineHrs = latestEng ? +(latestEng.data / 3600).toFixed(1) : '--';

            rows.push({
                truck: { id: d.id, name: d.name, sensorOk: hasSensor },
                stateKey: stateKey,
                moves: moves,
                lastSeen: lastSeen,
                fuelPct: fuelPct,
                defPct: defPct,
                engineHrs: engineHrs,
                isOffline: false,
                checkSensor: checkSensor
            });
        });

        return rows;
    }

    // ══════════════════════════════════════════════════════════
    //  HISTORICAL: FLEET SUMMARY FETCH
    // ══════════════════════════════════════════════════════════

    async function fetchFleetSummary(api, numDays) {
        numDays = numDays || 7;
        var periodStart = opDayBounds(numDays - 1).start;
        var periodEnd   = opDayBounds(0).end;
        var psISO = periodStart.toISOString();
        var peISO = periodEnd.toISOString();

        // For each device: fuel start, eng hrs start, speed, jaw, rpm (5 calls per device)
        var calls = [];
        cachedDevices.forEach(function (d) {
            calls.push(sdSearch(d.id, DIAG.FUEL_USED,    psISO, peISO, 1));      // 0: fuel start
            calls.push(sdSearch(d.id, DIAG.ENGINE_HOURS,  psISO, peISO, 1));     // 1: eng hrs start
            calls.push(sdSearch(d.id, DIAG.SPEED,         psISO, peISO, 20000)); // 2: speed
            calls.push(sdSearch(d.id, DIAG.AUX1,          psISO, peISO, 20000)); // 3: jaw
            calls.push(sdSearch(d.id, DIAG.RPM,           psISO, peISO, 20000)); // 4: RPM
        });

        // End boundaries: fuel end + eng hrs end from last 2 hours of period
        var lateFrom = new Date(periodEnd.getTime() - 2 * 36e5).toISOString();
        var endCalls = [];
        cachedDevices.forEach(function (d) {
            endCalls.push(sdSearch(d.id, DIAG.FUEL_USED,   lateFrom, peISO));
            endCalls.push(sdSearch(d.id, DIAG.ENGINE_HOURS, lateFrom, peISO));
        });

        var mainResults = await multi(api, calls);
        var endResults  = await multi(api, endCalls);

        var fleet = cachedDevices.map(function (d, i) {
            var base = i * 5;
            var fuelStartRec = mainResults[base]     && mainResults[base][0];
            var engStartRec  = mainResults[base + 1] && mainResults[base + 1][0];
            var speedData    = mainResults[base + 2] || [];
            var jawData      = mainResults[base + 3] || [];
            var rpmData      = mainResults[base + 4] || [];

            var fuelEndRec   = last(endResults[i * 2]     || []);
            var engEndRec    = last(endResults[i * 2 + 1]  || []);

            var hasSensor = sensorMap[d.id];

            // ── Fuel delta (gallons) ──
            var fuelStartL = fuelStartRec ? fuelStartRec.data : 0;
            var fuelEndL   = fuelEndRec   ? fuelEndRec.data   : fuelStartL;
            var tF = +((fuelEndL - fuelStartL) * LITERS_TO_GAL).toFixed(1);
            if (tF < 0) tF = 0; // ECM reset guard

            // ── Engine hours delta ──
            var engStart = engStartRec ? engStartRec.data / 3600 : 0;
            var engEnd   = engEndRec   ? engEndRec.data / 3600   : engStart;
            var tEH = +(engEnd - engStart).toFixed(1);
            if (tEH < 0) tEH = 0; // ECM reset guard

            // ── GPH ──
            var avgGph = tEH > 0 ? +(tF / tEH).toFixed(1) : 0;

            // ── Max speed (mph) ──
            var maxSpd = 0;
            speedData.forEach(function (sp) {
                var mph = sp.data * KPH_TO_MPH;
                if (mph > maxSpd) maxSpd = mph;
            });
            maxSpd = +maxSpd.toFixed(0);

            // ── Activity classification for idle% and waste ──
            var totalIdleMin = 0;
            var totalOnMin = 0;
            var activity = classifyTimeSeries(rpmData, speedData, jawData, hasSensor, periodStart.getTime(), periodEnd.getTime());
            totalIdleMin = activity.bobtailIdle;
            totalOnMin = activity.moving + activity.bobtailing + activity.coupledIdle + activity.bobtailIdle;
            var idlePct = totalOnMin > 0 ? +((totalIdleMin / totalOnMin) * 100).toFixed(0) : 0;

            // ── Waste fuel: fuel burned during bobtail idle ──
            var waste = null;
            if (hasSensor && totalOnMin > 0 && tEH > 0) {
                var idleHrs = totalIdleMin / 60;
                waste = +(idleHrs * avgGph).toFixed(1); // approximate: idle hours × avg GPH
            }

            // ── Moves ──
            var totalMoves = null;
            if (hasSensor) {
                totalMoves = countMoves(jawData, speedData);
            }

            return {
                truck: { id: d.id, name: d.name, sensorOk: hasSensor },
                avgGph: avgGph, waste: waste, idlePct: idlePct,
                totalMoves: totalMoves, maxSpd: maxSpd, tEH: tEH, tF: tF
            };
        });

        return fleet;
    }

    // ══════════════════════════════════════════════════════════
    //  HISTORICAL: SINGLE DAY FETCH (for drill-down)
    // ══════════════════════════════════════════════════════════

    async function fetchTruckDay(api, device, dayIdx) {
        var cacheKey = device.id + '-' + dayIdx;
        if (dayCache[cacheKey]) return dayCache[cacheKey];

        var bounds = opDayBounds(dayIdx);
        var hasSensor = sensorMap[device.id];

        var calls = [
            sdSearch(device.id, DIAG.RPM,          bounds.startISO, bounds.endISO, 20000),
            sdSearch(device.id, DIAG.SPEED,         bounds.startISO, bounds.endISO, 20000),
            sdSearch(device.id, DIAG.AUX1,          bounds.startISO, bounds.endISO, 20000),
            sdSearch(device.id, DIAG.FUEL_USED,     bounds.startISO, bounds.endISO),
            sdSearch(device.id, DIAG.ENGINE_HOURS,   bounds.startISO, bounds.endISO)
        ];

        var results = await multi(api, calls);
        var rpmData   = results[0] || [];
        var speedData = results[1] || [];
        var jawData   = results[2] || [];
        var fuelData  = results[3] || [];
        var engData   = results[4] || [];

        // Build 6 slots
        var slots = [];
        for (var si = 0; si < 6; si++) {
            var slotStart = new Date(bounds.start);
            var slotEnd   = new Date(bounds.start);

            // Handle the cross-midnight slot (12-4 AM = hours 0-4 of NEXT day)
            if (SLOT_HOURS[si][0] >= OP_DAY_START) {
                slotStart.setHours(SLOT_HOURS[si][0], 0, 0, 0);
                slotEnd.setHours(SLOT_HOURS[si][1], 0, 0, 0);
            } else {
                // Slots 0-4 AM are on the next calendar day
                slotStart.setDate(slotStart.getDate() + (SLOT_HOURS[si][0] < OP_DAY_START ? 1 : 0));
                slotStart.setHours(SLOT_HOURS[si][0], 0, 0, 0);
                slotEnd.setDate(bounds.start.getDate() + 1);
                slotEnd.setHours(SLOT_HOURS[si][1], 0, 0, 0);
            }

            var ssMs = slotStart.getTime();
            var seMs = slotEnd.getTime();

            // Classify activity for this slot
            var slotRpm   = filterByTime(rpmData, ssMs, seMs);
            var slotSpeed = filterByTime(speedData, ssMs, seMs);
            var slotJaw   = filterByTime(jawData, ssMs, seMs);
            var act = classifyTimeSeries(slotRpm, slotSpeed, slotJaw, hasSensor, ssMs, seMs);

            // Fuel delta for this slot
            var slotFuel = filterByTime(fuelData, ssMs, seMs);
            var fStart = slotFuel.length ? slotFuel[0].data : 0;
            var fEnd   = slotFuel.length ? slotFuel[slotFuel.length - 1].data : fStart;
            var fuelGal = +((fEnd - fStart) * LITERS_TO_GAL).toFixed(1);
            if (fuelGal < 0) fuelGal = 0;

            // Engine hours delta for this slot
            var slotEng = filterByTime(engData, ssMs, seMs);
            var eStart = slotEng.length ? slotEng[0].data / 3600 : 0;
            var eEnd   = slotEng.length ? slotEng[slotEng.length - 1].data / 3600 : eStart;
            var engH = +(eEnd - eStart).toFixed(1);
            if (engH < 0) engH = 0;

            var gph = engH > 0 ? +(fuelGal / engH).toFixed(1) : 0;

            slots.push({
                label: SLOT_LABELS[si],
                offMin: act.offMin,
                moving: act.moving,
                bobtailing: act.bobtailing,
                coupledIdle: act.coupledIdle,
                bobtailIdle: act.bobtailIdle,
                engH: engH,
                fuel: fuelGal,
                gph: gph,
                fb: !hasSensor
            });
        }

        // Day totals
        var sum = function (fn) { return slots.reduce(function (a, s) { return a + fn(s); }, 0); };
        var tEH = +sum(function (s) { return s.engH; }).toFixed(1);
        var tF  = +sum(function (s) { return s.fuel; }).toFixed(1);
        var tIdleMin = sum(function (s) { return s.bobtailIdle; });
        var tOnMin   = sum(function (s) { return s.moving + s.bobtailing + s.coupledIdle + s.bobtailIdle; });
        var idlePct  = tOnMin > 0 ? +((tIdleMin / tOnMin) * 100).toFixed(0) : 0;
        var avgGph   = tEH > 0 ? +(tF / tEH).toFixed(1) : 0;
        var waste    = !hasSensor ? null : +(tIdleMin / 60 * avgGph).toFixed(1);
        var moves    = hasSensor ? countMoves(jawData, speedData) : null;
        var maxSpd   = 0;
        speedData.forEach(function (sp) { var mph = sp.data * KPH_TO_MPH; if (mph > maxSpd) maxSpd = mph; });

        var dayData = {
            truck: { id: device.id, name: device.name, sensorOk: hasSensor },
            slots: slots, tEH: tEH, tF: tF, idlePct: idlePct,
            avgGph: avgGph, waste: waste, moves: moves,
            maxSpd: +maxSpd.toFixed(0), fb: !hasSensor
        };
        dayCache[cacheKey] = dayData;
        return dayData;
    }

    // ══════════════════════════════════════════════════════════
    //  TIME-SERIES CLASSIFIER
    // ══════════════════════════════════════════════════════════

    function filterByTime(data, startMs, endMs) {
        return data.filter(function (d) {
            var t = new Date(d.dateTime).getTime();
            return t >= startMs && t <= endMs;
        });
    }

    function classifyTimeSeries(rpmData, speedData, jawData, hasSensor, startMs, endMs) {
        // Merge all events into a single timeline
        var events = [];
        rpmData.forEach(function (r) { events.push({ time: new Date(r.dateTime).getTime(), type: 'rpm', value: r.data }); });
        speedData.forEach(function (s) { events.push({ time: new Date(s.dateTime).getTime(), type: 'speed', value: s.data }); });
        jawData.forEach(function (j) { events.push({ time: new Date(j.dateTime).getTime(), type: 'jaw', value: j.data }); });
        events.sort(function (a, b) { return a.time - b.time; });

        var curRpm = 0, curSpeed = 0, curJaw = hasSensor ? 0 : null;
        var moving = 0, bobtailing = 0, coupledIdle = 0, bobtailIdle = 0, offMin = 0;
        var prevTime = startMs;

        events.forEach(function (evt) {
            if (evt.time < startMs || evt.time > endMs) return;
            var dt = Math.max(0, evt.time - prevTime) / 60000;
            var state = classifyState(curRpm, curSpeed * KPH_TO_MPH, curJaw);
            switch (state) {
                case 'MOVING':       moving += dt; break;
                case 'BOBTAILING':   bobtailing += dt; break;
                case 'COUPLED_IDLE': coupledIdle += dt; break;
                case 'BOBTAIL_IDLE': bobtailIdle += dt; break;
                case 'OFF':          offMin += dt; break;
            }
            if (evt.type === 'rpm')   curRpm = evt.value;
            if (evt.type === 'speed') curSpeed = evt.value;
            if (evt.type === 'jaw')   curJaw = evt.value;
            prevTime = evt.time;
        });

        // Remaining time to endMs
        var remaining = Math.max(0, endMs - prevTime) / 60000;
        var lastState = classifyState(curRpm, curSpeed * KPH_TO_MPH, curJaw);
        switch (lastState) {
            case 'MOVING':       moving += remaining; break;
            case 'BOBTAILING':   bobtailing += remaining; break;
            case 'COUPLED_IDLE': coupledIdle += remaining; break;
            case 'BOBTAIL_IDLE': bobtailIdle += remaining; break;
            case 'OFF':          offMin += remaining; break;
        }

        return {
            moving: Math.round(moving), bobtailing: Math.round(bobtailing),
            coupledIdle: Math.round(coupledIdle), bobtailIdle: Math.round(bobtailIdle),
            offMin: Math.round(offMin)
        };
    }

    function countMoves(jawData, speedData) {
        if (!jawData || jawData.length < 2) return 0;
        var moves = 0;
        var prevJaw = jawData[0].data;
        for (var j = 1; j < jawData.length; j++) {
            if (jawData[j].data === 1 && prevJaw === 0) {
                var lockTime = new Date(jawData[j].dateTime).getTime();
                var unlockTime = lockTime + 600000;
                for (var jj = j + 1; jj < jawData.length; jj++) {
                    if (jawData[jj].data === 0) { unlockTime = new Date(jawData[jj].dateTime).getTime(); break; }
                }
                for (var s = 0; s < speedData.length; s++) {
                    var st = new Date(speedData[s].dateTime).getTime();
                    if (st >= lockTime && st <= unlockTime && speedData[s].data > 3.22) { moves++; break; }
                }
            }
            prevJaw = jawData[j].data;
        }
        return moves;
    }

    // ══════════════════════════════════════════════════════════
    //  RENDER: LIVE DISPATCHER  (identical to demo)
    // ══════════════════════════════════════════════════════════

    var currentShift = 12;

    async function renderLive() {
        var tbody = document.getElementById('liveBody');
        tbody.innerHTML = loadingRow(6, 'Fetching live fleet data…');

        try {
            var data = await fetchLiveData(geotabApi, currentShift);

            tbody.innerHTML = '';
            data.forEach(function (row) {
                var tr = document.createElement('tr');

                var tdAsset = el('td', '', '');
                tdAsset.innerHTML = '<div class="asset-cell"><span class="asset-id">' + row.truck.name + '</span>' + sensorBadgeHTML(row.truck.sensorOk) + '</div>';

                var tdState = el('td', '', '');
                tdState.innerHTML = stateBadgeHTML(row.stateKey, !row.truck.sensorOk && !row.isOffline, row.isOffline, row.checkSensor);

                var tdMoves = el('td', '', '');
                if (row.moves === '--') {
                    tdMoves.innerHTML = '<span class="text-faint">—</span>';
                } else {
                    tdMoves.innerHTML = '<span class="move-count">' + row.moves + '</span>';
                    if (!row.truck.sensorOk && !row.isOffline) tdMoves.innerHTML += '<div class="move-est">EST · RPM</div>';
                }

                var tdSeen = el('td', '', '');
                var seenStr = row.lastSeen.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
                if (row.isOffline) {
                    tdSeen.innerHTML = '<span class="text-red text-bold" style="font-size:12px">' + seenStr + '</span><div class="offline-label">7+ DAYS — NO HEARTBEAT</div>';
                } else {
                    tdSeen.innerHTML = '<span style="font-size:12px;color:#6b7280">' + seenStr + '</span>';
                }

                var tdFuel = el('td', '', '');
                if (row.fuelPct === '--') {
                    tdFuel.innerHTML = '<span class="text-faint">—</span>';
                } else {
                    var fc = parseInt(row.fuelPct) < 25 ? 'text-red text-bold' : 'text-bold';
                    tdFuel.innerHTML = '<span class="' + fc + '" style="font-size:13px">' + row.fuelPct + '</span>' +
                                       '<span class="text-muted" style="margin-left:12px;font-size:12px">' + row.defPct + '</span>';
                }

                var tdEng = el('td', '', '');
                tdEng.innerHTML = row.engineHrs === '--' ? '<span class="text-faint">—</span>' : '<span style="font-size:13px;color:#6b7280">' + row.engineHrs + ' h</span>';

                tr.appendChild(tdAsset); tr.appendChild(tdState); tr.appendChild(tdMoves);
                tr.appendChild(tdSeen); tr.appendChild(tdFuel); tr.appendChild(tdEng);
                tbody.appendChild(tr);
            });
            wireTips(tbody);
        } catch (err) {
            console.error('Live render error:', err);
            tbody.innerHTML = loadingRow(6, 'Error loading data. Check console.');
        }

        buildLegend(document.getElementById('liveLegend'), true);
    }

    // ══════════════════════════════════════════════════════════
    //  RENDER: HISTORICAL AUDIT  (identical to demo)
    // ══════════════════════════════════════════════════════════

    var auditState = { view: 'fleet', truckId: null, day: 0 };
    var NUM_DAYS = 7;

    async function renderAuditFleet() {
        var tbody = document.getElementById('auditBody');
        tbody.innerHTML = loadingRow(8, 'Building fleet summary (' + NUM_DAYS + ' days)…');
        document.getElementById('kpiCards').innerHTML = '';
        document.getElementById('auditMeta').textContent = '';

        try {
            fleetCache = await fetchFleetSummary(geotabApi, NUM_DAYS);
            var fleet = fleetCache;

            // KPI Cards
            var totalWaste = fleet.reduce(function (a, t) { return a + (t.waste || 0); }, 0).toFixed(1);
            var fleetGph = +(fleet.reduce(function (a, t) { return a + t.avgGph; }, 0) / Math.max(fleet.length, 1)).toFixed(1);
            var totalEH = fleet.reduce(function (a, t) { return a + t.tEH; }, 0).toFixed(0);

            var kpiRow = document.getElementById('kpiCards');
            kpiRow.innerHTML = '';
            var cards = [
                { label: 'Total Waste Fuel', value: totalWaste, unit: 'gallons', color: '#dc2626', sub: 'Bobtail Idle fuel burn (sensor trucks)' },
                { label: 'Fleet Avg GPH', value: fleetGph, unit: 'gal/eng-hr', color: gphColor(fleetGph), sub: '< 2.0 efficient · 2.0–3.0 monitor · > 3.0 alert' },
                { label: 'Total Engine Hours', value: totalEH, unit: 'hours', color: '#0c4a6e', sub: 'All ' + fleet.length + ' assets combined' }
            ];
            cards.forEach(function (c) {
                var card = el('div', 'kpi-card');
                card.style.borderLeftColor = c.color;
                card.innerHTML = '<div class="kpi-card__label">' + c.label + '</div><div class="kpi-card__value"><span class="kpi-card__num" style="color:' + c.color + '">' + c.value + '</span><span class="kpi-card__unit">' + c.unit + '</span></div><div class="kpi-card__sub">' + c.sub + '</div>';
                kpiRow.appendChild(card);
            });

            // Meta
            var pStart = opDayBounds(NUM_DAYS - 1).start;
            var pEnd   = opDayBounds(0).end;
            document.getElementById('auditMeta').textContent = fmtDay(pStart) + ' – ' + fmtDay(pEnd) + ' · Operational Day: 4:00 AM – 3:59 AM · Click row to drill down';

            // Table
            tbody.innerHTML = '';
            fleet.forEach(function (row) {
                var tr = document.createElement('tr');
                tr.setAttribute('data-clickable', '1');
                tr.addEventListener('click', function () {
                    auditState.truckId = row.truck.id;
                    auditState.day = 0;
                    auditState.view = 'drill';
                    showAuditView();
                });
                var gc = gphClass(row.avgGph);
                tr.innerHTML =
                    '<td><div class="asset-cell"><span class="asset-id" style="font-size:14px">' + row.truck.name + '</span>' + sensorBadgeHTML(row.truck.sensorOk) + '</div></td>' +
                    '<td><span class="gph-pill gph-pill--' + gc + '">' + row.avgGph + '</span><div class="gph-tag" style="color:' + gphColor(row.avgGph) + '">' + gphTag(row.avgGph) + '</div></td>' +
                    '<td style="font-weight:700;font-size:14px;color:' + (row.waste !== null ? '#dc2626' : '#bbb') + '">' + (row.waste !== null ? row.waste + ' gal' : '<span class="text-faint" style="font-size:11px;color:#ca8a04">N/A</span>') + '</td>' +
                    '<td><span style="font-weight:700;font-size:14px;color:' + (row.idlePct > 50 ? '#dc2626' : row.idlePct > 35 ? '#ca8a04' : '#16a34a') + '">' + row.idlePct + '%</span></td>' +
                    '<td style="font-weight:700;font-size:14px">' + (row.totalMoves !== null ? row.totalMoves : '<span class="text-faint" style="font-size:11px;color:#ca8a04">N/A</span>') + '</td>' +
                    '<td><span style="font-weight:600;color:' + (row.maxSpd > 18 ? '#dc2626' : '#111827') + '">' + row.maxSpd + ' mph</span></td>' +
                    '<td style="font-size:13px;color:#6b7280">' + row.tEH + ' h</td>' +
                    '<td style="font-size:13px;color:#6b7280">' + row.tF + ' gal</td>';
                tbody.appendChild(tr);
            });
            wireTips(tbody);
        } catch (err) {
            console.error('Audit fleet error:', err);
            tbody.innerHTML = loadingRow(8, 'Error loading historical data. Check console.');
        }

        buildLegend(document.getElementById('auditLegend'), true);
    }

    // ── DRILL-DOWN RENDERER ────────────────────────────────────

    async function renderDrillDown() {
        var device = cachedDevices.filter(function (d) { return d.id === auditState.truckId; })[0];
        if (!device) return;
        var hasSensor = sensorMap[device.id];

        // Day bar
        var dayBar = document.getElementById('dayBar');
        dayBar.innerHTML = '';
        for (var d = 0; d < NUM_DAYS; d++) {
            var bounds = opDayBounds(d);
            var btn = el('button', 'day-btn' + (d === auditState.day ? ' day-btn--active' : ''));
            btn.textContent = fmtDay(bounds.start);
            btn.setAttribute('data-day', d);
            btn.addEventListener('click', function () {
                auditState.day = parseInt(this.getAttribute('data-day'));
                renderDrillDown();
            });
            dayBar.appendChild(btn);
        }

        // Show loading in drill card
        document.getElementById('drillKpis').innerHTML = '<div style="color:#9ca3af;font-size:13px;padding:20px">Loading day data…</div>';
        document.getElementById('ribbon').innerHTML = '';

        try {
            var data = await fetchTruckDay(geotabApi, device, auditState.day);

            // Header
            document.getElementById('drillTruckName').innerHTML = '<span>' + device.name + '</span>' + sensorBadgeHTML(hasSensor);
            var dayBounds = opDayBounds(auditState.day);
            document.getElementById('drillDate').innerHTML = '<strong>' + fmtDay(dayBounds.start) + '</strong><span class="drill__date-range">4:00 AM – 3:59 AM</span>';

            // KPIs
            var kpis = document.getElementById('drillKpis');
            var kpiData = [
                { l: 'GPH', v: data.avgGph, c: gphColor(data.avgGph), bg: gphBg(data.avgGph) },
                { l: 'Waste Fuel', v: data.waste !== null ? data.waste + ' gal' : '—', c: data.waste !== null ? '#dc2626' : '#bbb', bg: 'rgba(220,38,38,0.05)' },
                { l: 'Eng Hrs', v: data.tEH + ' h', c: '#0c4a6e', bg: 'rgba(12,74,110,0.05)' },
                { l: 'Fuel', v: data.tF + ' gal', c: '#111827', bg: '#f9fafb' },
                { l: 'Idle %', v: data.idlePct + '%', c: data.idlePct > 50 ? '#dc2626' : data.idlePct > 35 ? '#ca8a04' : '#16a34a', bg: '#f9fafb' }
            ];
            kpis.innerHTML = kpiData.map(function (k) {
                return '<div class="drill-kpi" style="background:' + k.bg + '"><div class="drill-kpi__label">' + k.l + '</div><div class="drill-kpi__val" style="color:' + k.c + '">' + k.v + '</div></div>';
            }).join('');

            // Ribbon axis
            document.getElementById('ribbonAxis').innerHTML = SLOT_LABELS.map(function (l) { return '<span class="ribbon__axis-label">' + l + '</span>'; }).join('');

            // Activity Ribbon
            var ribbon = document.getElementById('ribbon');
            ribbon.innerHTML = '';
            data.slots.forEach(function (s) {
                var slot = el('div', 'ribbon__slot');
                var t = 240;
                if (s.fb) {
                    var onPct = ((s.moving + s.bobtailing + s.coupledIdle + s.bobtailIdle) / t) * 100;
                    slot.innerHTML = '<svg width="100%" height="' + onPct + '%" style="display:block;min-height:' + (onPct > 0 ? '4px' : '0') + '" data-tip="RPM Only — no jaw sensor data."><rect width="100%" height="100%" fill="url(#hatch)"/></svg>' +
                        '<div style="flex:1;background:#374151;opacity:0.18"></div><div class="ribbon__gph">—</div>';
                } else {
                    var segs = [
                        { min: s.moving, cls: 'moving', st: 'MOVING' },
                        { min: s.bobtailing, cls: 'bobtailing', st: 'BOBTAILING' },
                        { min: s.coupledIdle, cls: 'coupled-idle', st: 'COUPLED_IDLE' },
                        { min: s.bobtailIdle, cls: 'bobtail-idle', st: 'BOBTAIL_IDLE' },
                        { min: s.offMin, cls: 'off', st: 'OFF' }
                    ];
                    var html = '';
                    segs.forEach(function (seg) {
                        var pct = (seg.min / t) * 100;
                        if (pct > 0) {
                            html += '<div class="ribbon__seg ribbon__seg--' + seg.cls + '" style="height:' + pct + '%" data-tip="' + STATES[seg.st].label + ': ' + seg.min + 'm — ' + STATES[seg.st].tip + '"></div>';
                        }
                    });
                    html += '<div class="ribbon__gph">' + s.gph + '</div>';
                    slot.innerHTML = html;
                }
                ribbon.appendChild(slot);
            });

            // Slot bar + detail
            renderSlotBar(data);
            renderSlotDetail(data, 0);

            // Fallback banner
            var banner = document.getElementById('fallbackBanner');
            if (data.fb) banner.classList.remove('fallback-banner--hidden');
            else banner.classList.add('fallback-banner--hidden');

            buildLegend(document.getElementById('drillLegend'), data.fb);
            wireTips(document.getElementById('drillCard'));
            wireTips(document.getElementById('drillTruckName'));
        } catch (err) {
            console.error('Drill-down error:', err);
            document.getElementById('drillKpis').innerHTML = '<div style="color:#dc2626;font-size:13px;padding:20px">Error loading day data. Check console.</div>';
        }
    }

    function renderSlotBar(data) {
        var bar = document.getElementById('slotBar');
        bar.innerHTML = '';
        data.slots.forEach(function (s, i) {
            var btn = el('button', 'slot-btn' + (i === 0 ? ' slot-btn--active' : ''));
            btn.textContent = s.label;
            btn.setAttribute('data-slot', i);
            btn.addEventListener('click', function () {
                var idx = parseInt(this.getAttribute('data-slot'));
                bar.querySelectorAll('.slot-btn').forEach(function (b) { b.classList.remove('slot-btn--active'); });
                this.classList.add('slot-btn--active');
                renderSlotDetail(data, idx);
            });
            bar.appendChild(btn);
        });
    }

    function renderSlotDetail(data, idx) {
        var s = data.slots[idx];
        var panel = document.getElementById('slotDetail');
        var onMin = s.moving + s.bobtailing + s.coupledIdle + s.bobtailIdle;

        var metricsHTML = '<div class="slot-detail__metrics">' +
            '<div><div class="slot-metric__label">GPH</div><div class="slot-metric__val" style="color:' + (s.fb ? '#9ca3af' : gphColor(s.gph)) + '">' + (s.fb ? '—' : s.gph) + '</div></div>' +
            '<div><div class="slot-metric__label">Fuel</div><div class="slot-metric__val" style="color:#111827">' + s.fuel + ' <span style="font-size:12px;color:#9ca3af">gal</span></div></div>' +
            '<div><div class="slot-metric__label">Eng Hrs</div><div class="slot-metric__val" style="color:#111827">' + s.engH + ' <span style="font-size:12px;color:#9ca3af">h</span></div></div>';
        if (s.fb) metricsHTML += '<div class="slot-fallback-tag"><span class="slot-fallback-tag__dot"></span>RPM ONLY — No State Split</div>';
        metricsHTML += '</div>';

        var statesHTML = '';
        if (!s.fb) {
            var chips = [
                { l: 'Moving', min: s.moving, c: STATES.MOVING.color, tip: STATES.MOVING.tip },
                { l: 'Bobtailing', min: s.bobtailing, c: STATES.BOBTAILING.color, tip: STATES.BOBTAILING.tip },
                { l: 'Coupled Idle', min: s.coupledIdle, c: STATES.COUPLED_IDLE.color, tip: STATES.COUPLED_IDLE.tip },
                { l: 'Bobtail Idle', min: s.bobtailIdle, c: STATES.BOBTAIL_IDLE.color, tip: STATES.BOBTAIL_IDLE.tip },
                { l: 'Off', min: s.offMin, c: STATES.OFF.color, tip: STATES.OFF.tip }
            ];
            statesHTML = '<div class="slot-detail__states">';
            chips.forEach(function (ch) {
                statesHTML += '<div class="slot-state-chip" data-tip="' + ch.tip + '"><span class="slot-state-chip__swatch" style="background:' + ch.c + '"></span><span class="slot-state-chip__label">' + ch.l + '</span><span class="slot-state-chip__min">' + ch.min + 'm</span></div>';
            });
            statesHTML += '</div>';
        } else {
            statesHTML = '<div class="slot-fallback-text">Engine On: ' + onMin + 'm · Off: ' + s.offMin + 'm — Five-state split requires JAW SENSOR.</div>';
        }

        panel.innerHTML = metricsHTML + statesHTML;
        wireTips(panel);
    }

    // ══════════════════════════════════════════════════════════
    //  VIEW SWITCHING
    // ══════════════════════════════════════════════════════════

    var activeTab = 'live';

    function switchTab(tab) {
        activeTab = tab;
        document.getElementById('viewLive').classList.toggle('view--hidden', tab !== 'live');
        document.getElementById('viewAudit').classList.toggle('view--hidden', tab !== 'audit');
        document.getElementById('tabLive').classList.toggle('tab-bar__btn--active', tab === 'live');
        document.getElementById('tabAudit').classList.toggle('tab-bar__btn--active', tab === 'audit');
        if (tab === 'live') renderLive();
        if (tab === 'audit') { auditState.view = 'fleet'; fleetCache = null; dayCache = {}; showAuditView(); }
    }

    function showAuditView() {
        var isFleet = auditState.view === 'fleet';
        document.getElementById('auditFleet').style.display = isFleet ? '' : 'none';
        document.getElementById('auditDrill').classList.toggle('drill--hidden', isFleet);
        if (isFleet) renderAuditFleet();
        else renderDrillDown();
    }

    function wireShiftButtons() {
        var labels = { '12': 'Rolling 12 Hours', '5': 'Since 05:00 AM (Day)', '15': 'Since 03:00 PM (Night)' };
        var btns = document.querySelectorAll('.shift-btn');
        btns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                currentShift = parseInt(this.getAttribute('data-shift'));
                btns.forEach(function (b) { b.classList.remove('shift-btn--active'); });
                this.classList.add('shift-btn--active');
                document.getElementById('shiftLabel').textContent = labels[currentShift] || 'Rolling 12 Hours';
                renderLive();
            });
        });
    }

    // ══════════════════════════════════════════════════════════
    //  GEOTAB ADD-IN ENTRY POINT
    // ══════════════════════════════════════════════════════════

    geotab.addin.spotterIQ = function (api, state) {
        return {
            initialize: async function (freshApi, freshState, callback) {
                geotabApi = freshApi;
                geotabState = freshState;
                initTooltip();

                // Load devices filtered by the user's selected group
                try {
                    await loadDevices(freshApi, freshState);
                } catch (e) {
                    console.error('Device load failed:', e);
                }

                // Resolve group name for header from the selected group filter
                try {
                    var leafName = await resolveLeafGroup(freshApi, freshState);
                    document.getElementById('leafGroupName').textContent = leafName;
                } catch (e) {
                    document.getElementById('leafGroupName').textContent = 'Fleet';
                }

                // Tab switching
                document.getElementById('tabLive').addEventListener('click', function () { switchTab('live'); });
                document.getElementById('tabAudit').addEventListener('click', function () { switchTab('audit'); });

                // Drill back
                document.getElementById('drillBack').addEventListener('click', function () {
                    auditState.view = 'fleet';
                    showAuditView();
                });

                // Shift buttons
                wireShiftButtons();

                // Initial render
                renderLive();

                callback();
            },

            focus: async function (freshApi, freshState) {
                geotabApi = freshApi;
                geotabState = freshState;

                // Reload devices in case the user changed the group filter
                try {
                    await loadDevices(freshApi, freshState);
                    var leafName = await resolveLeafGroup(freshApi, freshState);
                    document.getElementById('leafGroupName').textContent = leafName;
                } catch (e) {
                    console.warn('Focus reload error:', e);
                }

                // Clear caches so audit view re-fetches for the new group
                fleetCache = null;
                dayCache = {};

                if (activeTab === 'live') renderLive();
                else showAuditView();
            },

            blur: function () {
                // Nothing to clean up
            }
        };
    };

})();
