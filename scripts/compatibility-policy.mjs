export const minimumWordPressBaseline = '6.4';
export const minimumPhpBaseline = '7.4';

function compareVersions(left, right) {
  return left.localeCompare(right, undefined, { numeric: true });
}

export function validateCompatibilityBaseline(target, context = 'repository') {
  const errors = [];
  if (target?.enabled === true && typeof target.manifest?.minimum_wordpress === 'string' && compareVersions(target.manifest.minimum_wordpress, minimumWordPressBaseline) < 0) {
    errors.push(`${context}.manifest minimum_wordpress must be ${minimumWordPressBaseline} or newer for an enabled portfolio repository.`);
  }
  if (target?.enabled === true && typeof target.manifest?.minimum_php === 'string' && compareVersions(target.manifest.minimum_php, minimumPhpBaseline) < 0) {
    errors.push(`${context}.manifest minimum_php must be ${minimumPhpBaseline} or newer for an enabled portfolio repository.`);
  }
  return errors;
}
