import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

// Production Firebase config is optional: drop google-services.json into app/ to use a real project.
// Without it the app runs against the local Firebase Emulator Suite (demo-homehub).
val hasGoogleServices = file("google-services.json").exists()
if (hasGoogleServices) apply(plugin = "com.google.gms.google-services")

val keystoreProperties = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun prop(name: String, default: String) = (project.findProperty(name) as String?) ?: default

android {
    namespace = "com.e404.homehub"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.e404.homehub"
        minSdk = 26
        targetSdk = 37
        versionCode = 2
        versionName = "1.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("boolean", "HAS_GOOGLE_SERVICES", hasGoogleServices.toString())
        // 10.0.2.2 is the host machine from the Android emulator.
        buildConfigField("String", "EMULATOR_HOST", "\"${prop("homehub.emulatorHost", "10.0.2.2")}\"")
        buildConfigField("String", "GATEWAY_URL", "\"${prop("homehub.gatewayUrl", "")}\"")
    }

    signingConfigs {
        if (keystoreProperties.containsKey("storeFile")) {
            create("release") {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            buildConfigField("boolean", "USE_EMULATORS", (prop("homehub.emulators", (!hasGoogleServices).toString())).toString())
            manifestPlaceholders["usesCleartext"] = "true"
        }
        release {
            buildConfigField("boolean", "USE_EMULATORS", "false")
            manifestPlaceholders["usesCleartext"] = "false"
            signingConfigs.findByName("release")?.let { signingConfig = it }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
        unitTests.isIncludeAndroidResources = true
    }
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

// Hermes Mobile ships the exact skill files the server Hermes uses (single source of truth).
val syncHermesSkills by tasks.registering(Sync::class) {
    from(rootProject.file("../agents/hermes/skills"))
    include("**/SKILL.md")
    into(layout.projectDirectory.dir("src/main/assets/hermes/skills"))
}
tasks.named("preBuild") { dependsOn(syncHermesSkills) }

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(platform(libs.firebase.bom))

    implementation(libs.androidx.core)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.work)

    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material3.adaptive)
    implementation(libs.compose.material.icons)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)

    implementation(libs.firebase.auth)
    implementation(libs.firebase.firestore)
    implementation(libs.firebase.storage)
    implementation(libs.firebase.messaging)
    implementation(libs.firebase.appcheck.playintegrity)
    debugImplementation(libs.firebase.appcheck.debug)

    implementation(libs.coroutines.android)
    implementation(libs.coroutines.play.services)
    implementation(libs.okhttp)
    implementation(libs.serialization.json)
    implementation(libs.haze)

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.room.testing)
    androidTestImplementation(libs.work.testing)
    androidTestImplementation(libs.coroutines.test)
}
