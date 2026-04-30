package sample.app

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.katana.KatanaApiClient
import com.example.katana.models.KatanaResponse
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class KatanaDetailViewModel(
    savedStateHandle: SavedStateHandle,
    private val apiClient: KatanaApiClient
) : ViewModel() {

    // 1. Navigation で定義したキー "katanaId" で値を取り出す
    val katanaId: String = checkNotNull(savedStateHandle["katanaId"])

    private val _katana = MutableStateFlow<KatanaResponse?>(null)
    val katana: StateFlow<KatanaResponse?> = _katana

    init {
        fetchDetail()
    }

    private fun fetchDetail() {
        viewModelScope.launch {
            // 本来は ID 指定の API があると良いですが、
            // 今回は全件から ID で検索する例にします
            val list = apiClient.fetchKatanas()
            _katana.value = list.find { it.id == katanaId }
        }
    }
}