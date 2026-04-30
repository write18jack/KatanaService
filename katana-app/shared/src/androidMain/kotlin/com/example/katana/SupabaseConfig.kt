package com.example.katana


actual object SupabaseConfig {
    actual val url: String = BuildConfig.SUPABASE_URL
    actual val key: String = BuildConfig.SUPABASE_KEY
}