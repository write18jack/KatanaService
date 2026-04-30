package sample.app

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.example.katana.KatanaApiClient
import com.example.katana.models.KatanaResponse
import kotlinx.coroutines.launch
import sample.app.ui.KatanaDetailScreen
import sample.app.ui.KatanaFormScreen
import sample.app.ui.KatanaListScreen
import sample.app.ui.LoginScreen

// 画面の定義（ルート名）
sealed class Screen(val route: String) {
    object Login : Screen("login")
    object List : Screen("list")
    object Detail : Screen("detail/{katanaId}") {
        fun createRoute(katanaId: String) = "detail/$katanaId"
    }

    object Add : Screen("add")
    object Edit : Screen("edit/{katanaId}") {
        fun createRoute(katanaId: String) = "edit/$katanaId"
    }
}

@Composable
fun App(
    // Android側から「画像選択してByte配列を返す処理」を注入してもらう
    onPickImage: (onImagePicked: (ByteArray) -> Unit) -> Unit
) {
    MaterialTheme {
        val coroutineScope = rememberCoroutineScope()
        val navController = rememberNavController()
        val apiClient = remember { KatanaApiClient() }
        // ViewModelを初期化（apiClientを渡す）
        val uploadViewModel = remember { KatanaUploadViewModel(apiClient) }

        // ログインしたユーザーのIDを保持する（登録時に使用するため）
        var loggedInUserId by remember { mutableStateOf<String?>(null) }
        // データを保持（本来はViewModelで管理するのが理想的ですが、まずはここで）
        var katanas by remember { mutableStateOf<List<KatanaResponse>>(emptyList()) }

        NavHost(navController = navController, startDestination = Screen.Login.route) {

            // --- ログイン画面 ---
            composable(Screen.Login.route) {
                LoginScreen(
                    apiClient = apiClient,
                    onLoginSuccess = { userId ->
                        loggedInUserId = userId
                        // ログイン成功したら一覧へ（戻れないようにバックスタックをクリア）
                        navController.navigate(Screen.List.route) {
                            popUpTo(Screen.Login.route) { inclusive = true }
                        }
                    }
                )
            }

            // --- 一覧画面 ---
            composable(Screen.List.route) {

                // ログアウト後に「戻る」ボタンで一覧に戻ってしまうのを防ぐ
                LaunchedEffect(loggedInUserId) {
                    if (loggedInUserId == null) {
                        navController.navigate(Screen.Login.route) {
                            popUpTo(0)
                        }
                    }
                }

                // 一覧画面に移動したタイミングでデータを再取得する
                LaunchedEffect(Unit) {
                    try {
                        katanas = apiClient.fetchKatanas()
                    } catch (e: Exception) { /* エラー処理 */
                    }
                }

                KatanaListScreen(
                    katanas = katanas,
                    loggedInUserId = loggedInUserId ?: "",
                    onItemClick = { katana ->
                        navController.navigate(Screen.Detail.createRoute(katana.id))
                    },
                    onAddClick = {
                        navController.navigate("add")
                    },
                    onLogout = {
                        // 1. 状態をクリア
                        loggedInUserId = null
                        // 2. ログイン画面へ戻る（バックスタックを空にする）
                        navController.navigate(Screen.Login.route) {
                            popUpTo(0) { inclusive = true }
                        }
                    }
                )
            }

            // --- 詳細画面 ---
            composable(
                route = Screen.Detail.route,
                arguments = listOf(navArgument("katanaId") { type = NavType.StringType })
            ) { backStackEntry ->

                // ログインチェックのガード ログインしていない状態（セッション切れなど）で詳細画面に留まれるのはリスク
                // loggedInUserId が null の場合、即座にログイン画面（または一覧）へ戻す
                LaunchedEffect(loggedInUserId) {
                    if (loggedInUserId == null) {
                        navController.navigate(Screen.Login.route) {
                            // バックスタックを全てクリアしてログイン画面へ
                            popUpTo(0) { inclusive = true }
                        }
                    }
                }

                // viewModel 関数でインスタンス化。
                // factory を指定することで、SavedStateHandle と apiClient を渡す。
                val detailViewModel: KatanaDetailViewModel = viewModel {
                    KatanaDetailViewModel(
                        savedStateHandle = createSavedStateHandle(),
                        apiClient = apiClient
                    )
                }
                val katanaId = detailViewModel.katanaId
                println("Navigating to Detail: id = $katanaId")

                val selectedKatana = katanas.find { it.id == katanaId }

                if (loggedInUserId != null && selectedKatana != null) {
                    KatanaDetailScreen(
                        katana = selectedKatana,
                        loggedInUserId = loggedInUserId!!,
                        viewModel = uploadViewModel,
                        onEditClick = { katana ->
                            // 編集画面へ遷移
                            navController.navigate(Screen.Edit.createRoute(katana.id))
                        },
                        onBack = { navController.popBackStack() },
                        onDeleted = {
                            navController.popBackStack() // 削除成功したら一覧に戻る
                        }
                    )
                } else {
                    println("Katana not found in the list!")
                }
            }

            // --- 登録画面 ---
            composable(
                route = Screen.Add.route
            ) {
                KatanaFormScreen(
                    viewModel = uploadViewModel,
                    onPickImage = onPickImage,
                    dealerId = loggedInUserId, // 取得したユーザーIDを渡す
                    onSaved = {
                        navController.popBackStack() // 登録成功したら一覧に戻る
                    },
                    onBack = {
                        navController.popBackStack() // 戻るボタン
                    }
                )
            }

            // --- 編集画面 ---
            composable(
                route = Screen.Edit.route,
                arguments = listOf(navArgument("katanaId") { type = NavType.StringType })
            ) { backStackEntry ->
                // 1. ログインチェック（ガード）
                LaunchedEffect(loggedInUserId) {
                    if (loggedInUserId == null) {
                        navController.navigate(Screen.Login.route) {
                            popUpTo(0) { inclusive = true }
                        }
                    }
                }

                // 2. IDから対象の刀データを特定
                val detailViewModel: KatanaDetailViewModel = viewModel {
                    KatanaDetailViewModel(
                        savedStateHandle = createSavedStateHandle(),
                        apiClient = apiClient
                    )
                }
                val katanaId = detailViewModel.katanaId
                val selectedKatana = katanas.find { it.id == katanaId }

                // 3. データが存在する場合のみフォームを表示
                if (selectedKatana != null) {
                    KatanaFormScreen(
                        viewModel = uploadViewModel,
                        onPickImage = { onImagePicked ->
                            // 画像ピッカーの呼び出し処理（Addと同じ）
                            onPickImage(onImagePicked)
                        },
                        dealerId = loggedInUserId,
                        existingKatana = selectedKatana, // ★ここが重要：既存データを渡す
                        onSaved = {
                            // 保存成功したら一覧に戻り、最新データを再取得
                            navController.popBackStack()
                            coroutineScope.launch {
                                katanas = apiClient.fetchKatanas()
                            }
                        },
                        onBack = {
                            navController.popBackStack()
                        }
                    )
                }
            }
        }
    }
}
