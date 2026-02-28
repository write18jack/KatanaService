package sample.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.katana.models.KatanaResponse

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KatanaDetailScreen(katana: KatanaResponse, onBack: () -> Unit) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("刀剣詳細") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState())
        ) {
            // 大きな名前表示
            Text(text = katana.name, style = MaterialTheme.typography.headlineLarge)
            Text(text = "店舗: ${katana.shopName}", color = MaterialTheme.colorScheme.secondary)

            Spacer(modifier = Modifier.height(24.dp))

            // 詳細情報テーブル風
            DetailRow("価格", "¥${formatPrice(katana.price)}")
            DetailRow("種別", katana.katanaType.name)
            DetailRow("時代", katana.era)
            DetailRow("状態", katana.status)
            DetailRow("ID", katana.id)

            Spacer(modifier = Modifier.height(32.dp))

            Button(
                onClick = { /* 購入/予約ロジック等 */ },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("この刀剣について問い合わせる")
            }
        }
    }
}

@Composable
fun DetailRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(text = label, fontWeight = FontWeight.Bold)
        Text(text = value)
    }
}