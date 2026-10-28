import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import wrapperJar from "./starter/gradle-wrapper.jar" with { type: "file" };
import gradlewScript from "./starter/gradlew" with { type: "file" };
import gradlewBatch from "./starter/gradlew.bat" with { type: "file" };
import { createFile } from "./files.ts";
import { CLERK_ANDROID_MIN_SDK } from "./sdk.ts";

export interface AndroidStarterProject {
  /** The app's display name, root project name, and theme name; a Kotlin identifier. */
  name: string;
  /** The `applicationId`, which is also the Gradle namespace and Kotlin package. */
  applicationId: string;
}

/** A leading letter keeps the name a Kotlin identifier, a theme name, and a package segment. */
export const ANDROID_APP_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The toolchain the starter pins: Android Studio's Empty Activity template as of AGP 9, with the
 * Kotlin Gradle plugin on the classpath through the Compose compiler plugin alias (AGP 9's
 * built-in Kotlin would be 2.2.10, which the Clerk SDK can't be consumed by). Setup reads these
 * back, so the Kotlin version is at least `CLERK_ANDROID_KOTLIN_MINIMUM`.
 */
export const STARTER_VERSIONS = {
  agp: "9.2.1",
  kotlin: "2.3.21",
  coreKtx: "1.18.0",
  lifecycleRuntimeKtx: "2.10.0",
  activityCompose: "1.13.0",
  composeBom: "2026.05.01",
  compileSdk: 36,
  targetSdk: 36,
  /** The embedded wrapper's distribution; `gradle-wrapper.properties` pins its checksum. */
  gradle: "9.4.1",
  gradleSha256: "2ab2958f2a1e51120c326cad6f385153bb11ee93b3c216c5fccebfdfbb7ec6cb",
} as const;

/** The Compose theme function the template declares, from the app name. */
export const themeName = (name: string) => `${name}Theme`;

/** The template's `MainActivity`, which setup recognizes to add the sign-in screen. */
export const starterMainActivity = (
  applicationId: string,
  name: string,
) => `package ${applicationId}

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import ${applicationId}.ui.theme.${themeName(name)}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ${themeName(name)} {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    Greeting(
                        name = "Android",
                        modifier = Modifier.padding(innerPadding)
                    )
                }
            }
        }
    }
}

@Composable
fun Greeting(name: String, modifier: Modifier = Modifier) {
    Text(
        text = "Hello $name!",
        modifier = modifier
    )
}

@Preview(showBackground = true)
@Composable
fun GreetingPreview() {
    ${themeName(name)} {
        Greeting("Android")
    }
}
`;

/**
 * The starter's `MainActivity` with Clerk's prebuilt sign-in: a progress indicator until the SDK
 * is initialized, `AuthView` until the auth flow completes, then the user button and email.
 */
export const signInMainActivity = (applicationId: string, name: string) => `package ${applicationId}

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.clerk.api.Clerk
import com.clerk.ui.auth.AuthView
import com.clerk.ui.userbutton.UserButton
import ${applicationId}.ui.theme.${themeName(name)}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val isInitialized by Clerk.isInitialized.collectAsState()
            val isAuthFlowComplete by Clerk.isAuthFlowCompleteFlow.collectAsState()
            val user by Clerk.userFlow.collectAsState()
            ${themeName(name)} {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    Box(
                        modifier = Modifier.fillMaxSize().padding(innerPadding),
                        contentAlignment = Alignment.Center,
                    ) {
                        when {
                            !isInitialized -> CircularProgressIndicator()
                            !isAuthFlowComplete -> AuthView(isDismissible = false)
                            else ->
                                Column(
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                    verticalArrangement = Arrangement.spacedBy(16.dp),
                                ) {
                                    UserButton()
                                    Text(
                                        text = "Signed in as \${user?.primaryEmailAddress?.emailAddress}",
                                        style = MaterialTheme.typography.titleMedium,
                                    )
                                }
                        }
                    }
                }
            }
        }
    }
}
`;

const GITIGNORE = `*.iml
.gradle
/local.properties
/.idea/caches
/.idea/libraries
/.idea/modules.xml
/.idea/workspace.xml
/.idea/navEditor.xml
/.idea/assetWizardSettings.xml
.DS_Store
/build
/captures
.externalNativeBuild
.cxx
local.properties
.kotlin
`;

/** The text files of the starter, keyed by path. The wrapper's binaries are copied separately. */
export function starterProjectFiles(project: AndroidStarterProject): Record<string, string> {
  const { name, applicationId } = project;
  const v = STARTER_VERSIONS;
  const sources = `app/src/main/java/${applicationId.replaceAll(".", "/")}`;
  return {
    "settings.gradle.kts": `pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\\\.android.*")
                includeGroupByRegex("com\\\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "${name}"
include(":app")
`,
    "build.gradle.kts": `// Top-level build file where you can add configuration options common to all sub-projects/modules.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
`,
    "gradle.properties": `# Project-wide Gradle settings.
# Specifies the JVM arguments used for the daemon process.
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
# AndroidX package structure to make it clearer which packages are bundled with the
# Android operating system, and which are packaged with your app's APK
android.useAndroidX=true
# Kotlin code style for this project: "official" or "obsolete":
kotlin.code.style=official
# Enables namespacing of each library's R class so that its R class includes only the
# resources declared in the library itself and none from the library's dependencies.
android.nonTransitiveRClass=true
`,
    "gradle/libs.versions.toml": `[versions]
agp = "${v.agp}"
kotlin = "${v.kotlin}"
coreKtx = "${v.coreKtx}"
lifecycleRuntimeKtx = "${v.lifecycleRuntimeKtx}"
activityCompose = "${v.activityCompose}"
composeBom = "${v.composeBom}"

[libraries]
androidx-core-ktx = { group = "androidx.core", name = "core-ktx", version.ref = "coreKtx" }
androidx-lifecycle-runtime-ktx = { group = "androidx.lifecycle", name = "lifecycle-runtime-ktx", version.ref = "lifecycleRuntimeKtx" }
androidx-activity-compose = { group = "androidx.activity", name = "activity-compose", version.ref = "activityCompose" }
androidx-compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "composeBom" }
androidx-compose-ui = { group = "androidx.compose.ui", name = "ui" }
androidx-compose-ui-graphics = { group = "androidx.compose.ui", name = "ui-graphics" }
androidx-compose-ui-tooling = { group = "androidx.compose.ui", name = "ui-tooling" }
androidx-compose-ui-tooling-preview = { group = "androidx.compose.ui", name = "ui-tooling-preview" }
androidx-compose-material3 = { group = "androidx.compose.material3", name = "material3" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
`,
    "gradle/wrapper/gradle-wrapper.properties": `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionSha256Sum=${v.gradleSha256}
distributionUrl=https\\://services.gradle.org/distributions/gradle-${v.gradle}-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`,
    ".gitignore": GITIGNORE,
    "app/.gitignore": "/build\n",
    "app/build.gradle.kts": `plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "${applicationId}"
    compileSdk = ${v.compileSdk}
    defaultConfig {
        applicationId = "${applicationId}"
        minSdk = ${CLERK_ANDROID_MIN_SDK}
        targetSdk = ${v.targetSdk}
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
`,
    "app/proguard-rules.pro": `# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
`,
    "app/src/main/AndroidManifest.xml": `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:icon="@drawable/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@style/Theme.${name}">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:theme="@style/Theme.${name}">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />

                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>

</manifest>
`,
    "app/src/main/res/values/strings.xml": `<resources>
    <string name="app_name">${name}</string>
</resources>
`,
    "app/src/main/res/values/themes.xml": `<?xml version="1.0" encoding="utf-8"?>
<resources>

    <style name="Theme.${name}" parent="android:Theme.Material.Light.NoActionBar" />
</resources>
`,
    "app/src/main/res/drawable/ic_launcher.xml": `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#6C47FF"
        android:pathData="M18,0h72a18,18 0 0 1 18,18v72a18,18 0 0 1 -18,18h-72a18,18 0 0 1 -18,-18v-72a18,18 0 0 1 18,-18z" />
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M54,30a24,24 0 1 0 0,48a24,24 0 1 0 0,-48zM54,42a12,12 0 1 1 0,24a12,12 0 1 1 0,-24z" />
</vector>
`,
    [`${sources}/MainActivity.kt`]: starterMainActivity(applicationId, name),
    [`${sources}/ui/theme/Color.kt`]: `package ${applicationId}.ui.theme

import androidx.compose.ui.graphics.Color

val Purple80 = Color(0xFFD0BCFF)
val PurpleGrey80 = Color(0xFFCCC2DC)
val Pink80 = Color(0xFFEFB8C8)

val Purple40 = Color(0xFF6650a4)
val PurpleGrey40 = Color(0xFF625b71)
val Pink40 = Color(0xFF7D5260)
`,
    [`${sources}/ui/theme/Theme.kt`]: `package ${applicationId}.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext

private val DarkColorScheme = darkColorScheme(
    primary = Purple80,
    secondary = PurpleGrey80,
    tertiary = Pink80
)

private val LightColorScheme = lightColorScheme(
    primary = Purple40,
    secondary = PurpleGrey40,
    tertiary = Pink40
)

@Composable
fun ${themeName(name)}(
    darkTheme: Boolean = isSystemInDarkTheme(),
    // Dynamic color is available on Android 12+
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }

        darkTheme -> DarkColorScheme
        else -> LightColorScheme
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = Typography,
        content = content
    )
}
`,
    [`${sources}/ui/theme/Type.kt`]: `package ${applicationId}.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// Set of Material typography styles to start with
val Typography = Typography(
    bodyLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.5.sp
    )
)
`,
  };
}

/**
 * The Gradle wrapper the CLI embeds, so a new project builds with \`./gradlew\` without Gradle on
 * PATH: the \`gradlew\` scripts and the wrapper jar from Gradle ${STARTER_VERSIONS.gradle}, whose
 * distribution the properties file pins by checksum.
 */
const WRAPPER_FILES: { path: string; source: string; mode: number }[] = [
  { path: "gradlew", source: gradlewScript, mode: 0o755 },
  { path: "gradlew.bat", source: gradlewBatch, mode: 0o644 },
  { path: "gradle/wrapper/gradle-wrapper.jar", source: wrapperJar, mode: 0o644 },
];

/** Whether `directory` is inside a Git work tree already, in which case no repository is made. */
async function insideGitRepository(directory: string): Promise<boolean> {
  const child = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd: directory,
    stdout: "ignore",
    stderr: "ignore",
    timeout: 5_000,
  });
  return (await child.exited) === 0;
}

/**
 * `git init` plus an initial commit, so the setup that follows edits tracked files Git can restore
 * and leaves no backups behind. Best effort: a missing Git, or no commit identity, is no reason to
 * fail a new project.
 */
async function initializeRepository(directory: string): Promise<void> {
  const run = async (args: string[]) => {
    const child = Bun.spawn(["git", ...args], {
      cwd: directory,
      stdout: "ignore",
      stderr: "ignore",
      timeout: 15_000,
    });
    return (await child.exited) === 0;
  };
  try {
    if (!(await run(["init", "-q"]))) return;
    if (!(await run(["add", "-A"]))) return;
    await run(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "Initial commit"]);
  } catch {
    // Git isn't installed.
  }
}

/**
 * Writes a new starter into `directory`, which must not exist yet, and initializes a Git
 * repository with an initial commit there unless it's already inside one. A failure removes the
 * partly written directory, so a retry starts clean.
 */
export async function writeAndroidStarter(
  directory: string,
  project: AndroidStarterProject,
): Promise<void> {
  await mkdir(directory);
  try {
    for (const [path, content] of Object.entries(starterProjectFiles(project))) {
      await mkdir(join(directory, dirname(path)), { recursive: true });
      await createFile(directory, path, content);
    }
    for (const { path, source, mode } of WRAPPER_FILES) {
      await mkdir(join(directory, dirname(path)), { recursive: true });
      await Bun.write(join(directory, path), Bun.file(source), { mode });
    }
    if (!(await insideGitRepository(directory))) await initializeRepository(directory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
