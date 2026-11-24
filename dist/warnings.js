/**
 * warnings.ts - Warnings a store hands to its caller instead of printing them
 */
/**
 * Hand `warning` to `onWarning`. Without a handler, `print` writes it to the
 * console as QMD always has.
 */
export function reportWarning(onWarning, warning, print) {
    if (onWarning)
        onWarning(warning);
    else
        print(warning.message);
}
