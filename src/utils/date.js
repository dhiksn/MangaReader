/**
 * Format date string or Date object into Indonesian relative time (e.g. '2 jam yang lalu').
 * @param {string|Date|number} dateInput
 * @returns {string|null}
 */
function formatRelativeTime(dateInput) {
  if (!dateInput) return null;

  const date = new Date(dateInput);
  if (isNaN(date.getTime())) return String(dateInput);

  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return 'Baru saja';

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffMonth = Math.floor(diffDay / 30);
  const diffYear = Math.floor(diffDay / 365);

  if (diffSec < 60) {
    return 'Baru saja';
  }
  if (diffMin < 60) {
    return `${diffMin} menit yang lalu`;
  }
  if (diffHour < 24) {
    return `${diffHour} jam yang lalu`;
  }
  if (diffDay < 30) {
    return `${diffDay} hari yang lalu`;
  }
  if (diffMonth < 12) {
    return `${diffMonth} bulan yang lalu`;
  }
  return `${diffYear} tahun yang lalu`;
}

module.exports = {
  formatRelativeTime,
};
