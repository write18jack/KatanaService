plugins {
    alias(libs.plugins.multiplatform)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.compose)
    alias(libs.plugins.android.application)
}

kotlin {
    jvmToolchain(17)

    androidTarget()
    listOf(
        iosX64(),
        iosArm64(),
        iosSimulatorArm64()
    ).forEach {
        it.binaries.framework {
            baseName = "ComposeApp"
            isStatic = true
        }
    }

    sourceSets {
        commonMain.dependencies {
            implementation(compose.runtime)
            implementation(compose.ui)
            implementation(compose.foundation)
            implementation(libs.navigation.compose)
            implementation(libs.compose.material.icons.extended)
            implementation(libs.compose.material3)
            implementation(libs.compose.ui.tooling.preview)
            implementation(project(":shared"))
        }

        androidMain.dependencies {
            implementation(libs.androidx.activityCompose)
        }

        // ここが重要：Android 実行時の「描画エンジン」を追加
        val androidMain by getting {
            dependencies {
                // libs.versions.toml で定義した compose-ui-tooling を使用
                implementation(libs.compose.ui.tooling)
            }
        }
    }
}

android {
    namespace = "sample.app"
    compileSdk = 35

    defaultConfig {
        minSdk = 23
        targetSdk = 35

        applicationId = "sample.app.androidApp"
        versionCode = 1
        versionName = "1.0.0"
    }
}

