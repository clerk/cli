plugins {
    id("com.android.application")
}

android {
    namespace = "com.clerk.cli.e2e"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.clerk.cli.e2e"
        minSdk = 24
        targetSdk = 36
    }
}
