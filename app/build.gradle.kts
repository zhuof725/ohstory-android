plugins {
    id("com.android.application")
    kotlin("android")
    id("com.chaquo.python")
}

android {
    namespace = "ai.zenstory.ohstory"
    compileSdk = 34

    defaultConfig {
        applicationId = "ai.zenstory.ohstory"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "0.2.0"

        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.webkit:webkit:1.10.0")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}

chaquopy {
    defaultConfig {
        buildPython("python3")
        pip {
            // 原版脚本只用标准库
        }
    }
}
