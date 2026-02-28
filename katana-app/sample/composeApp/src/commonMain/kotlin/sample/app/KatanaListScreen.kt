package sample.app

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DividerDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.example.katana.models.KatanaResponse
import com.example.katana.models.KatanaType

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
fun KatanaListScreen(katanas: List<KatanaResponse>, onItemClick: (KatanaResponse) -> Unit) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = "刀剣販売一覧",
                        style = MaterialTheme.typography.headlineMedium,
                        modifier = Modifier.padding(bottom = 8.dp)
                    )
                }
            )
        },
        bottomBar = {

        },
        containerColor = MaterialTheme.colorScheme.background
    ) { paddingValues ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(paddingValues),
            //contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            if (katanas.isEmpty()) {
                item {
                    Text("データがありません。サーバーを起動していますか？")
                }
            } else {
                items(katanas) { katana ->
                    // クリックイベントを追加
                    Box(modifier = Modifier.clickable { onItemClick(katana) }) {
                        KatanaCard(katana)
                    }
                }
            }
        }
    }
}

@Composable
fun KatanaCard(katana: KatanaResponse) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 4.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = katana.name,
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold
                )
                // ステータスバッジ
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    color = MaterialTheme.colorScheme.primaryContainer
                ) {
                    Text(
                        text = katana.status,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        style = MaterialTheme.typography.labelSmall
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            Text(text = "種別: ${katana.katanaType}", style = MaterialTheme.typography.bodyMedium)
            Text(text = "時代: ${katana.era}", style = MaterialTheme.typography.bodyMedium)

            HorizontalDivider(
                Modifier.padding(vertical = 8.dp),
                DividerDefaults.Thickness,
                DividerDefaults.color
            )

            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "¥${formatPrice(katana.price)}",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.primary
                )
                Spacer(modifier = Modifier.weight(1f))
                Text(
                    text = katana.shopName,
                    style = MaterialTheme.typography.bodySmall,
                    fontStyle = FontStyle.Italic
                )
            }
        }
    }
}

// 金額のカンマ区切り用（簡易版）
fun formatPrice(price: Long): String =
    price.toString().reversed().chunked(3).joinToString(",").reversed()

@Preview
@Composable
fun KatanaCardPreview() {
    // プレビュー用にダミーデータを作成
    val dummyKatana = KatanaResponse(
        id = "1",
        shopName = "プレビュー刀剣店",
        name = "テストの刀",
        katanaType = KatanaType.打刀,
        era = "令和",
        price = 50000,
        status = "展示中",
        dealerId = "dealer-123",
        createdAt = "2024-01-01T00:00:00Z",
        updatedAt = "2024-01-30T00:00:00Z"
    )

    MaterialTheme {
        KatanaCard(dummyKatana)
    }
}
