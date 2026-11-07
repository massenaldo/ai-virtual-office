import type { JakartaDay } from './jakartaClock'

export type PrayerName = 'subuh' | 'dzuhur' | 'ashar' | 'maghrib' | 'isya'

// Jakarta, calculated in the Indonesian Kemenag way: Subuh at the sun 20 degrees below the horizon, Isya at 18, Ashar at a shadow
// as long as the object plus its noon shadow, Maghrib at sunset. Every time then gets IHTIYAT minutes of margin.
const LATITUDE = -6.2
const LONGITUDE = 106.8
const UTC_OFFSET_HOURS = 7
const SUBUH_ANGLE = 20
const ISYA_ANGLE = 18
const SUNSET_ANGLE = 0.8333
const IHTIYAT_MINUTES = 3

const rad = (deg: number) => (deg * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

/** Solar declination (degrees) and equation of time (minutes) at the given Julian day. */
function sunPosition(jd: number): { declination: number; equation: number } {
  const d = jd - 2451545.0
  const g = rad((357.529 + 0.98560028 * d) % 360)
  const q = (280.459 + 0.98564736 * d) % 360
  const l = rad((q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) % 360)
  const e = rad(23.439 - 0.00000036 * d)
  const ra = deg(Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l))) / 15
  const declination = deg(Math.asin(Math.sin(e) * Math.sin(l)))
  let eq = q / 15 - ((ra % 24) + 24) % 24
  if (eq > 12) eq -= 24
  if (eq < -12) eq += 24
  return { declination, equation: eq * 60 }
}

/** Minutes since Jakarta midnight for all five prayers on that day. */
export function prayerTimes(day: JakartaDay): Record<PrayerName, number> {
  // The sun is read at local noon, 05:00 UTC, which is accurate to well under a minute for the whole day.
  const jd = Date.UTC(day.year, day.month - 1, day.day, 5) / 86400000 + 2440587.5
  const { declination, equation } = sunPosition(jd)
  const noon = 12 * 60 + UTC_OFFSET_HOURS * 60 - (LONGITUDE / 15) * 60 - equation
  const sinLat = Math.sin(rad(LATITUDE))
  const cosLat = Math.cos(rad(LATITUDE))
  const sinDec = Math.sin(rad(declination))
  const cosDec = Math.cos(rad(declination))
  // Minutes between solar noon and the moment the sun is at the given altitude (degrees).
  const hourAngle = (altitude: number) => {
    const c = (Math.sin(rad(altitude)) - sinLat * sinDec) / (cosLat * cosDec)
    return (deg(Math.acos(Math.min(1, Math.max(-1, c)))) / 15) * 60
  }
  const asharAltitude = deg(Math.atan(1 / (1 + Math.tan(Math.abs(rad(LATITUDE - declination))))))
  const at = (minutes: number) => minutes + IHTIYAT_MINUTES
  return {
    subuh: at(noon - hourAngle(-SUBUH_ANGLE)),
    dzuhur: at(noon),
    ashar: at(noon + hourAngle(asharAltitude)),
    maghrib: at(noon + hourAngle(-SUNSET_ANGLE)),
    isya: at(noon + hourAngle(-ISYA_ANGLE)),
  }
}
