rootProject.name = "KatanaApp"

pluginManagement {
    repositories {
        google {
            content { 
              	includeGroupByRegex("com\\.android.*")
              	includeGroupByRegex("com\\.google.*")
              	includeGroupByRegex("androidx.*")
              	includeGroupByRegex("android.*")
            }
        }
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        google {
            content { 
              	includeGroupByRegex("com\\.android.*")
              	includeGroupByRegex("com\\.google.*")
              	includeGroupByRegex("androidx.*")
              	includeGroupByRegex("android.*")
            }
        }
        mavenCentral()

        maven("https://maven.pkg.jetbrains.space/public/p/compose/patch") {
            content {
                // JetBrains版の androidx グループをこのリポジトリから許可する
                includeGroup("org.jetbrains.androidx.navigation")
                includeGroup("org.jetbrains.androidx.lifecycle")
                includeGroup("org.jetbrains.androidx.controller")
            }
        }
    }
}
include(":shared")
include(":sample:composeApp")

