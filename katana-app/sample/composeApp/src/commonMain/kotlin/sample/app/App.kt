package sample.app

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.example.katana.KatanaApiClient
import com.example.katana.models.KatanaResponse

// 画面の定義（ルート名）
sealed class Screen(val route: String) {
    object List : Screen("list")
    object Detail : Screen("detail/{katanaId}") {
        fun createRoute(katanaId: String) = "detail/$katanaId"
    }
}

@Composable
fun App() {
    MaterialTheme {
        val navController = rememberNavController()
        val apiClient = remember { KatanaApiClient() }

        // データを保持（本来はViewModelで管理するのが理想的ですが、まずはここで）
        var katanas by remember { mutableStateOf<List<KatanaResponse>>(emptyList()) }

        NavHost(navController = navController, startDestination = Screen.List.route) {
            // 一覧画面
            composable(Screen.List.route) {
                KatanaListScreen(
                    katanas = katanas,
                    onItemClick = { katana ->
                        navController.navigate(Screen.Detail.createRoute(katana.id))
                    }
                )
            }

            // 詳細画面
            composable(
                route = Screen.Detail.route,
                arguments = listOf(navArgument("katanaId") { type = NavType.StringType })
            ) { backStackEntry ->
                val katanaId: String? = backStackEntry.savedStateHandle["katanaId"]

                val selectedKatana = katanas.find { it.id == katanaId }

                if (selectedKatana != null) {
                    KatanaDetailScreen(
                        katana = selectedKatana,
                        onBack = { navController.popBackStack() }
                    )
                }
            }
        }

        // 初回ロード
        LaunchedEffect(Unit) {
            try {
                katanas = apiClient.fetchKatanas()
            } catch (e: Exception) { /* エラー処理 */
            }
        }
    }
}
