package sample.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.example.katana.KatanaApiClient
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(
    apiClient: KatanaApiClient, // 前回のApiClientを渡す
    onLoginSuccess: (String) -> Unit // 成功時にuserIdを渡して画面遷移するコールバック
) {
    var name by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(
            "刀剣管理システム ログイン",
            style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.padding(bottom = 32.dp)
        )

        // --- 名前入力 ---
        TextField(
            value = name,
            onValueChange = { name = it },
            label = { Text("ユーザー名") },
            modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp),
            singleLine = true
        )

        // --- パスワード入力 ---
        TextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("パスワード") },
            modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp),
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(), // 伏せ字にする
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password)
        )

        // --- エラーメッセージ表示 ---
        if (errorMessage != null) {
            Text(
                errorMessage!!,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(bottom = 16.dp)
            )
        }

        // --- ログインボタン ---
        Button(
            onClick = {
                if (name.isBlank() || password.isBlank()) {
                    errorMessage = "名前とパスワードを入力してください"
                    return@Button
                }

                scope.launch {
                    isLoading = true
                    errorMessage = null

                    // 1. API呼び出し
                    val userResponse = apiClient.login(name, password)

                    isLoading = false

                    if (userResponse != null) {
                        // 2. 成功：userIdを渡して画面遷移
                        onLoginSuccess(userResponse.id)
                    } else {
                        // 3. 失敗
                        errorMessage = "ログインに失敗しました。名前かパスワードが違います。"
                    }
                }
            },
            modifier = Modifier.fillMaxWidth().height(50.dp),
            enabled = !isLoading // ロード中は無効化
        ) {
            if (isLoading) {
                CircularProgressIndicator(
                    color = MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier.size(24.dp)
                )
            } else {
                Text("ログイン")
            }
        }
    }
}