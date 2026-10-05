// Export a ride as TCX, which Strava, Garmin Connect and TrainingPeaks accept.

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * @param {object} ride
 * @param {number} ride.startTime  epoch ms
 * @param {string} ride.name
 * @param {{time:number, distance:number, speed:number, power:number, cadence:number,
 *          hr:number|null, ele:number, lat?:number, lon?:number}[]} ride.samples
 */
export function buildTcx({ startTime, name, samples }) {
  const iso = (ms) => new Date(ms).toISOString();
  const last = samples[samples.length - 1];
  const totalSeconds = last ? (last.time - startTime) / 1000 : 0;
  const distance = last ? last.distance : 0;

  const points = samples
    .map((s) => {
      const parts = [`<Time>${iso(s.time)}</Time>`];
      if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) {
        parts.push(
          `<Position><LatitudeDegrees>${s.lat.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${s.lon.toFixed(7)}</LongitudeDegrees></Position>`,
        );
      }
      parts.push(`<AltitudeMeters>${s.ele.toFixed(1)}</AltitudeMeters>`);
      parts.push(`<DistanceMeters>${s.distance.toFixed(1)}</DistanceMeters>`);
      if (s.hr > 0) parts.push(`<HeartRateBpm><Value>${Math.round(s.hr)}</Value></HeartRateBpm>`);
      parts.push(`<Cadence>${Math.min(254, Math.round(s.cadence || 0))}</Cadence>`);
      parts.push(
        `<Extensions><ns3:TPX><ns3:Speed>${s.speed.toFixed(2)}</ns3:Speed><ns3:Watts>${Math.round(s.power || 0)}</ns3:Watts></ns3:TPX></Extensions>`,
      );
      return `<Trackpoint>${parts.join('')}</Trackpoint>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
<Activities>
<Activity Sport="Biking">
<Id>${iso(startTime)}</Id>
<Lap StartTime="${iso(startTime)}">
<TotalTimeSeconds>${totalSeconds.toFixed(0)}</TotalTimeSeconds>
<DistanceMeters>${distance.toFixed(1)}</DistanceMeters>
<Calories>0</Calories>
<Intensity>Active</Intensity>
<TriggerMethod>Manual</TriggerMethod>
<Track>
${points}
</Track>
</Lap>
<Notes>${esc(`Indoor Warrior – ${name}`)}</Notes>
</Activity>
</Activities>
</TrainingCenterDatabase>
`;
}
