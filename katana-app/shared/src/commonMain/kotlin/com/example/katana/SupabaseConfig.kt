package com.example.katana

import io.github.jan.supabase.createSupabaseClient
import io.github.jan.supabase.storage.Storage

expect object SupabaseConfig {
    val url: String
    val key: String
}

// これを使えば SupabaseManager は commonMain のままで OK
object SupabaseManager {
    val client = createSupabaseClient(
        supabaseUrl = SupabaseConfig.url,
        supabaseKey = SupabaseConfig.key
    ) {
        install(Storage)
    }
}