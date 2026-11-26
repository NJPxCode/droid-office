import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The app's pure Kotlin core (parsing, protocol, terminal model, Thread presentation, Whiteboard),
// shared with the iOS companion. commonMain must stay free of JVM and Android APIs: each platform
// call goes through an expect in Platform.kt, and code only the Android app needs (the APK
// self-update, receipts) stays in the app module.
plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.kotlin.multiplatform.library)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(21)

    android {
        namespace = "ai.factory.droidoffice.core"
        compileSdk = 37
        minSdk = 28
        compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
        withHostTest {}
    }

    // Built only on a Mac with Xcode; elsewhere Kotlin skips these targets.
    iosArm64()
    iosSimulatorArm64()

    sourceSets {
        commonMain.dependencies {
            api(libs.kotlinx.coroutines.core)
            api(libs.kotlinx.serialization.json)
        }
        // The JUnit suite runs on the JVM for now; moving it to commonTest runs it on iOS too.
        getByName("androidHostTest").dependencies {
            implementation(libs.junit)
            implementation(libs.kotlinx.coroutines.test)
        }
    }
}
