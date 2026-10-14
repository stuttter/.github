export const minimumWordPressBaseline = '6.4';
export const minimumPhpBaseline = '7.4';

function compareVersions(left, right) {
  return left.localeCompare(right, undefined, { numeric: true });
}

export function validateCompatibilityBaseline(target, context = 'repository') {
  const errors = [];
  const exception = target?.compatibility_exception;
  const minimumWordPress = target?.manifest?.minimum_wordpress;
  if (target?.enabled === true && typeof minimumWordPress === 'string' && compareVersions(minimumWordPress, minimumWordPressBaseline) < 0) {
    if (
      !exception ||
      exception.minimum_wordpress !== minimumWordPress ||
      typeof exception.reason !== 'string' ||
      exception.reason.trim().length < 20
    ) {
      errors.push(`${context}.manifest minimum_wordpress must be ${minimumWordPressBaseline} or newer, or match a documented compatibility_exception.`);
    }
  } else if (exception) {
    errors.push(`${context}.compatibility_exception is only valid for an enabled repository below the WordPress compatibility baseline.`);
  }
  if (target?.enabled === true && typeof target.manifest?.minimum_php === 'string' && compareVersions(target.manifest.minimum_php, minimumPhpBaseline) < 0) {
    errors.push(`${context}.manifest minimum_php must be ${minimumPhpBaseline} or newer for an enabled portfolio repository.`);
  }
  return errors;
}
