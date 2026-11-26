package ai.factory.droidoffice.core

import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import platform.Foundation.NSDate
import platform.Foundation.NSDateFormatter
import platform.Foundation.NSDateFormatterMediumStyle
import platform.Foundation.NSDateFormatterShortStyle
import platform.Foundation.NSLocale
import platform.Foundation.NSMakeRange
import platform.Foundation.NSNumber
import platform.Foundation.NSNumberFormatter
import platform.Foundation.NSNumberFormatterDecimalStyle
import platform.Foundation.NSNumberFormatterRoundHalfUp
import platform.Foundation.NSString
import platform.Foundation.NSURLComponents
import platform.Foundation.compare
import platform.Foundation.create
import platform.Foundation.dateWithTimeIntervalSince1970

internal actual fun parseUri(text: String): UriParts? {
    val components = NSURLComponents.componentsWithString(text) ?: return null
    return UriParts(
        scheme = components.scheme,
        host = components.percentEncodedHost,
        port = components.port?.intValue ?: -1,
        rawPath = components.percentEncodedPath,
        rawQuery = components.percentEncodedQuery,
    )
}

internal actual fun formatDecimals(value: Double, decimals: Int): String {
    val formatter = NSNumberFormatter().apply {
        locale = NSLocale(localeIdentifier = "en_US_POSIX")
        numberStyle = NSNumberFormatterDecimalStyle
        usesGroupingSeparator = false
        roundingMode = NSNumberFormatterRoundHalfUp
        minimumIntegerDigits = 1u
        minimumFractionDigits = decimals.toULong()
        maximumFractionDigits = decimals.toULong()
    }
    return formatter.stringFromNumber(NSNumber(double = value)) ?: value.toString()
}

internal actual fun lowercaseCodePoint(codePoint: Int): Int {
    if (codePoint !in 0..0x10FFFF) return codePoint
    if (codePoint < 0x10000) return codePoint.toChar().lowercaseChar().code
    val lower = CodePoints.toString(codePoint).lowercase()
    return if (CodePoints.count(lower, 0, lower.length) == 1) CodePoints.at(lower, 0) else codePoint
}

internal actual fun isUppercaseCodePoint(codePoint: Int): Boolean {
    if (codePoint !in 0..0x10FFFF) return false
    if (codePoint < 0x10000) return codePoint.toChar().isUpperCase()
    val text = CodePoints.toString(codePoint)
    return text.lowercase() != text && text.uppercase() == text
}

@OptIn(BetaInteropApi::class, ExperimentalForeignApi::class)
internal actual fun collate(a: String, b: String): Int {
    val left = NSString.create(string = a)
    return left.compare(b, options = 0u, range = NSMakeRange(0u, left.length), locale = NSLocale(localeIdentifier = "")).toInt()
}

internal actual fun localDateTime(epochMillis: Long): String {
    val formatter = NSDateFormatter().apply {
        dateStyle = NSDateFormatterMediumStyle
        timeStyle = NSDateFormatterShortStyle
    }
    return formatter.stringFromDate(NSDate.dateWithTimeIntervalSince1970(epochMillis / 1000.0))
}
