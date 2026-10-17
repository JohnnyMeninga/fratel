export function validCoordinates(value) {
  return value != null && Number.isFinite(value.latitude) && Number.isFinite(value.longitude)
    && Math.abs(value.latitude) <= 90 && Math.abs(value.longitude) <= 180;
}

export function distanceKm(first, second) {
  if (!validCoordinates(first) || !validCoordinates(second)) return null;
  const radians = Math.PI / 180;
  const latitudeDelta = (second.latitude - first.latitude) * radians;
  const longitudeDelta = (second.longitude - first.longitude) * radians;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(first.latitude * radians) * Math.cos(second.latitude * radians)
    * Math.sin(longitudeDelta / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
}

export function mapPoints(ip, gps) {
  const points = [ip, gps].filter(validCoordinates).map(value => [value.latitude, value.longitude]);
  if (points.length === 2) {
    const delta = points[1][1] - points[0][1];
    if (delta > 180) points[1][1] -= 360;
    if (delta < -180) points[1][1] += 360;
  }
  return points;
}

function locationError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function requestBrowserLocation({
  geolocation = globalThis.navigator?.geolocation,
  secureContext = globalThis.isSecureContext,
  timeoutMs = 15000,
} = {}) {
  if (!secureContext) {
    return Promise.reject(locationError('INSECURE_CONTEXT', 'Browser location requires HTTPS or localhost.'));
  }
  if (!geolocation) {
    return Promise.reject(locationError('UNSUPPORTED', 'This browser does not support location access.'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(locationError('GPS_TIMEOUT', 'Location request timed out. Check permissions and retry.'));
    }, timeoutMs + 5000);
    const finish = (callback, value) => {
      clearTimeout(timer);
      callback(value);
    };
    try {
      geolocation.getCurrentPosition(position => {
        const { latitude, longitude, accuracy } = position.coords ?? {};
        if (!validCoordinates({ latitude, longitude }) || !Number.isFinite(accuracy) || accuracy < 0) {
          finish(reject, locationError('INVALID_GPS', 'Browser returned invalid location data.'));
          return;
        }
        const timestamp = Number.isFinite(position.timestamp) && Math.abs(position.timestamp) <= 8.64e15
          ? position.timestamp : Date.now();
        finish(resolve, { latitude, longitude, accuracy, timestamp });
      }, error => {
        const errors = {
          1: ['GPS_DENIED', 'Location permission denied. Allow location in browser site settings, then retry.'],
          2: ['GPS_UNAVAILABLE', 'Location is unavailable. Check device location services, then retry.'],
          3: ['GPS_TIMEOUT', 'Location request timed out. Check permissions and retry.'],
        };
        const [code, message] = errors[error?.code] ?? ['GPS_UNAVAILABLE', 'Browser location could not be determined.'];
        finish(reject, locationError(code, message));
      }, { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 });
    } catch {
      finish(reject, locationError('GPS_UNAVAILABLE', 'Browser location access is blocked or unavailable.'));
    }
  });
}